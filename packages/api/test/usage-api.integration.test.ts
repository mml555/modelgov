import { parseConfigObject } from "@modelgov/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";
import { reserveBudget } from "../src/modules/usage/repo";

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date("2026-06-30T12:00:00Z");

const config = parseConfigObject({
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 100, hard_stop_at_percent: 100 },
    by_user_type: {
      logged_in: { daily_usd: 1, daily_requests: 10, models: ["cheap"] },
    },
  },
  features: {
    support_chat: { safety: "dev", model_class: "cheap", max_tokens: 100 },
  },
  model_classes: {
    cheap: { primary: "openai/gpt-4o-mini" },
  },
  safety: { preset: "dev" },
});

describe.skipIf(!DATABASE_URL)("GET /v1/usage (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE budget_counters, request_logs");
    // Freeze the wall clock to NOW so the /v1/usage endpoint — which reads with
    // the real clock — computes the same UTC window the reservation is written
    // to. Without this the test flakes whenever a run straddles a UTC day/month
    // boundary. Only Date is faked; timers stay real so pg/fastify async I/O is
    // unaffected.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function opsApp(): FastifyInstance {
    return buildServer({
      config,
      pool,
      litellm: {
        chat: async () => ({
          content: "ok",
          model: "m",
          actualCostUsd: 0,
          raw: {},
        }),
      },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKeys: [
        { name: "ops", key: "secret", permissions: ["chat:create", "usage:read"] },
      ],
    });
  }

  it("returns global usage for operators with usage:read", async () => {
    await reserveBudget(pool, {
      projectId: "test",
      userId: "u1",
      feature: "support_chat",
      estimatedCostUsd: 0.05,
      caps: {
        userDailyUsd: 1,
        userDailyRequests: 10,
        featureMonthlyUsd: null,
        globalMonthlyUsd: 100,
      },
      now: NOW,
    });

    const res = await opsApp().inject({
      method: "GET",
      url: "/v1/usage?userId=u1&feature=support_chat",
      headers: { authorization: "Bearer secret" },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.globalMonthly.reservedUsd).toBeCloseTo(0.05, 6);
    expect(json.userDaily.usedUsd).toBe(0);
    expect(json.userDaily.reservedUsd).toBeCloseTo(0.05, 6);
    expect(json.featureMonthly.feature).toBe("support_chat");
  });

  it("rejects usage reads without usage:read permission", async () => {
    const limited = buildServer({
      config,
      pool,
      litellm: {
        chat: async () => ({
          content: "ok",
          model: "m",
          actualCostUsd: 0,
          raw: {},
        }),
      },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKeys: [{ name: "chat-only", key: "secret", permissions: ["chat:create"] }],
    });
    const res = await limited.inject({
      method: "GET",
      url: "/v1/usage",
      headers: { authorization: "Bearer secret" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("tenant-scoped keys require userId or feature and omit globalMonthly", async () => {
    const tenant = buildServer({
      config,
      pool,
      litellm: {
        chat: async () => ({
          content: "ok",
          model: "m",
          actualCostUsd: 0,
          raw: {},
        }),
      },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKeys: [
        {
          name: "tenant-a",
          key: "secret",
          projectId: "project-a",
          permissions: ["usage:read"],
        },
      ],
    });

    const blocked = await tenant.inject({
      method: "GET",
      url: "/v1/usage",
      headers: { authorization: "Bearer secret" },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("usage_scope_required");

    const ok = await tenant.inject({
      method: "GET",
      url: "/v1/usage?userId=u1",
      headers: { authorization: "Bearer secret" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().globalMonthly).toBeUndefined();
    expect(ok.json().projectId).toBe("project-a");
  });
});
