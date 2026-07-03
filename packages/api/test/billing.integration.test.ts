import { parseConfigObject } from "@modelgov/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import { createBillingService } from "../src/modules/billing/service";
import { topUpCreditsInTransaction } from "../src/modules/billing/repo";
import {
  type LiteLLMChatResult,
  type LiteLLMClient,
} from "../src/services/litellm";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";

const DATABASE_URL = process.env.DATABASE_URL;

const RAW_CONFIG = {
  project: { name: "billing-test", environment: "test" },
  budgets: {
    global: { monthly_usd: 100, daily_usd: 10, hard_stop_at_percent: 100 },
    by_user_type: {
      logged_in: { daily_usd: 5, daily_requests: 100, models: ["cheap"] },
    },
  },
  features: {
    support_chat: { safety: "dev", model_class: "cheap", max_tokens: 500 },
  },
  model_classes: {
    cheap: { primary: "openai/gpt-4o-mini" },
  },
  safety: { preset: "dev" },
  billing: {
    provider: "stripe",
    mode: "hybrid",
    stripe: { meter_event_name: "ai_tokens" },
  },
};

const config = parseConfigObject(RAW_CONFIG);

function okResult(model: string): LiteLLMChatResult {
  return {
    content: `reply from ${model}`,
    model,
    actualCostUsd: 0.05,
    inputTokens: 12,
    outputTokens: 8,
    raw: {},
  };
}

const OPS_HEADERS = { authorization: "Bearer ops-key" };
const CHAT_HEADERS = { authorization: "Bearer chat-key" };

describe.skipIf(!DATABASE_URL)("billing + emergency (integration)", () => {
  let pool: Pool;
  let billing: NonNullable<ReturnType<typeof createBillingService>>;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
    billing = createBillingService(pool, { billing: config.billing })!;
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE budget_counters, request_logs, idempotency_keys,
       billing_accounts, meter_events, webhook_outbox, system_flags,
       stripe_processed_events`,
    );
  });

  function appWith(litellm: LiteLLMClient): FastifyInstance {
    return buildServer({
      config,
      pool,
      litellm,
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      billing,
      logger: false,
      apiKeys: [
        { name: "chat", key: "chat-key", permissions: ["chat:create"] },
        {
          name: "ops",
          key: "ops-key",
          permissions: ["chat:create", "usage:read", "billing:write", "policy:read", "policy:write"],
        },
      ],
    });
  }

  const postChat = (
    app: FastifyInstance,
    body: Record<string, unknown>,
    headers = CHAT_HEADERS,
  ) => app.inject({ method: "POST", url: "/v1/chat", payload: body, headers });

  it("tops up credits and returns balance", async () => {
    const app = appWith({ chat: async (p) => okResult(p.model) });

    const topUp = await app.inject({
      method: "POST",
      url: "/v1/admin/billing/top-up",
      headers: OPS_HEADERS,
      payload: { userId: "u1", creditsUsd: 2.5 },
    });
    expect(topUp.statusCode).toBe(200);
    expect(topUp.json().balance.creditsUsd).toBeCloseTo(2.5, 6);

    const balance = await app.inject({
      method: "GET",
      url: "/v1/users/u1/balance",
      headers: OPS_HEADERS,
    });
    expect(balance.statusCode).toBe(200);
    expect(balance.json().creditsAvailableUsd).toBeCloseTo(2.5, 6);
    expect(balance.json().mode).toBe("hybrid");
  });

  it("blocks chat with insufficient_credits when wallet is empty", async () => {
    const app = appWith({ chat: async (p) => okResult(p.model) });
    const res = await postChat(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "support_chat",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe("insufficient_credits");
    expect(res.json().error.details.reasonCode).toBe("insufficient_credits");
  });

  it("allows chat and debits credits on settle in hybrid mode", async () => {
    const app = appWith({ chat: async (p) => okResult(p.model) });
    await billing.adminTopUp({ tenantId: "", userId: "u1", creditsUsd: 1 });

    const res = await postChat(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "support_chat",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.statusCode).toBe(200);

    const account = await pool.query(
      `SELECT credits_usd::float8 AS credits_usd, credits_reserved_usd::float8 AS reserved
       FROM billing_accounts WHERE user_id = 'u1'`,
    );
    expect(Number(account.rows[0].credits_usd)).toBeCloseTo(0.95, 4);
    expect(Number(account.rows[0].reserved)).toBeCloseTo(0, 6);

    const meters = await pool.query(
      `SELECT count(*)::int AS n FROM meter_events WHERE user_id = 'u1'`,
    );
    expect(meters.rows[0].n).toBe(1);
  });

  it("applies a Stripe top-up at most once per event id (replay-safe)", async () => {
    const first = await topUpCreditsInTransaction(pool, {
      tenantId: "",
      userId: "u_evt",
      creditsUsd: 3,
      stripeEventId: "evt_replay_1",
    });
    const replay = await topUpCreditsInTransaction(pool, {
      tenantId: "",
      userId: "u_evt",
      creditsUsd: 3,
      stripeEventId: "evt_replay_1",
    });
    expect(first).toBe(true);
    expect(replay).toBe(false);
    const balance = await billing.getBalance("", "u_evt");
    expect(balance.creditsUsd).toBeCloseTo(3, 6); // granted once, not doubled
  });

  it("rejects invalid stripe webhooks", async () => {
    const app = appWith({ chat: async (p) => okResult(p.model) });
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "stripe-signature": "t=1,v1=bad", "content-type": "application/json" },
      payload: { id: "evt_test", type: "ping", data: { object: {} } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("webhook_invalid");
  });

  it("pauses and resumes AI requests via emergency endpoints", async () => {
    const app = appWith({ chat: async (p) => okResult(p.model) });
    await billing.adminTopUp({ tenantId: "", userId: "u1", creditsUsd: 1 });

    const pause = await app.inject({
      method: "POST",
      url: "/v1/admin/emergency/pause",
      headers: OPS_HEADERS,
      payload: { reason: "test pause" },
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().paused).toBe(true);

    const blocked = await postChat(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "support_chat",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json().error.code).toBe("ai_requests_paused");

    const resume = await app.inject({
      method: "POST",
      url: "/v1/admin/emergency/resume",
      headers: OPS_HEADERS,
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().paused).toBe(false);

    const allowed = await postChat(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "support_chat",
      messages: [{ role: "user", content: "hi again" }],
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("enforces global daily budget cap", async () => {
    const day = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO budget_counters (scope, project_id, key, window_start, used_usd, reserved_usd, requests_used, tenant_id)
       VALUES ('global_daily', '', 'global', $1::date, 0.01, 0, 0, '')`,
      [day],
    );

    const tightConfig = parseConfigObject({
      ...RAW_CONFIG,
      budgets: {
        global: { monthly_usd: 100, daily_usd: 0.01, hard_stop_at_percent: 100 },
        by_user_type: RAW_CONFIG.budgets.by_user_type,
      },
      billing: { provider: "none", mode: "internal_only" },
    });
    const app = buildServer({
      config: tightConfig,
      pool,
      litellm: { chat: async (p) => okResult(p.model) },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      allowUnauthenticated: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        userId: "u1",
        userType: "logged_in",
        feature: "support_chat",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.reasonCode).toBe("global_daily_budget_exceeded");
  });
});
