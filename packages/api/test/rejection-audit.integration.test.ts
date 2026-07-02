import { parseConfigObject, type SafetyPlan } from "@ai-guard/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import {
  ProviderError,
  type LiteLLMChatParams,
  type LiteLLMChatResult,
  type LiteLLMClient,
} from "../src/services/litellm";
import { NoopObservability } from "../src/services/observability";
import {
  NoopGuard,
  type OutputSafetyResult,
  type SafetyGuard,
  type SafetyResult,
} from "../src/services/safety";
import { buildServer } from "../src/server";
import type { ChatMessage } from "../src/types";

// Every rejection a client can receive must leave a request_logs row — the
// audit trail is the product's core promise, so "rejected but unlogged" is a
// bug regardless of which branch rejected. These tests pin that invariant per
// rejection path. (400 contract violations — unknown feature/user_type — are
// intentionally NOT audited: arbitrary attacker-chosen feature strings would
// pollute the log with unbounded cardinality.)

const DATABASE_URL = process.env.DATABASE_URL;

const RAW_CONFIG = {
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
    by_user_type: {
      // daily_usd admits the primary estimate (~$0.000375) but NOT the pricier
      // fallback (~$0.0024) — used to force the fallback top-up to fail.
      anonymous: { daily_usd: 0.001, daily_requests: 100, models: ["cheap"] },
      logged_in: { daily_usd: 1, daily_requests: 100, models: ["cheap", "standard"] },
    },
  },
  features: {
    support_chat: { safety: "dev", model_class: "cheap", max_tokens: 500 },
    // Restricted feature: only the primary's provider is approved, so a
    // provider-failure fallback re-eval must BLOCK (fallback is anthropic).
    secure_chat: {
      safety: "dev",
      model_class: "cheap",
      max_tokens: 500,
      data_sensitivity: "restricted",
    },
  },
  data_classes: {
    restricted: { allowed_providers: ["openai"] },
  },
  model_classes: {
    cheap: { primary: "openai/gpt-4o-mini", fallback: "anthropic/claude-haiku" },
    standard: { primary: "anthropic/claude-sonnet", fallback: "openai/gpt-4o" },
  },
  safety: { preset: "dev" },
};

const config = parseConfigObject(RAW_CONFIG);

function okResult(model: string): LiteLLMChatResult {
  return {
    content: `reply from ${model}`,
    model,
    actualCostUsd: 0.0002,
    inputTokens: 12,
    outputTokens: 8,
    raw: {},
  };
}

const allowOutput = async (content: string): Promise<OutputSafetyResult> => ({
  action: "allow",
  content,
  piiMasked: false,
  findings: [],
});

const inputBlockingSafety: SafetyGuard = {
  async inspectInput(messages: ChatMessage[], _plan: SafetyPlan): Promise<SafetyResult> {
    return {
      action: "block",
      messages,
      piiMasked: false,
      injectionBlocked: true,
      findings: [{ type: "prompt_injection", detail: "test" }],
      blockReason: "prompt_injection",
      safetyCostUsd: 0,
    };
  },
  inspectOutput: allowOutput,
};

const outputBlockingSafety: SafetyGuard = {
  async inspectInput(messages: ChatMessage[]): Promise<SafetyResult> {
    return {
      action: "allow",
      messages,
      piiMasked: false,
      injectionBlocked: false,
      findings: [],
      safetyCostUsd: 0,
    };
  },
  async inspectOutput(content: string): Promise<OutputSafetyResult> {
    return {
      action: "block",
      content,
      piiMasked: false,
      findings: [{ type: "pii", detail: "US_SSN" }],
      blockReason: "output_pii_detected",
    };
  },
};

describe.skipIf(!DATABASE_URL)("rejection audit trail (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE budget_counters, request_logs, idempotency_keys");
  });

  function appWith(litellm: LiteLLMClient, safety: SafetyGuard = new NoopGuard()): FastifyInstance {
    return buildServer({
      config,
      pool,
      litellm,
      safety,
      observability: new NoopObservability(),
      logger: false,
      allowUnauthenticated: true,
    });
  }

  const post = (app: FastifyInstance, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/v1/chat", payload: body });

  async function auditRows(): Promise<
    Array<{
      status: string;
      decision: string;
      reason_code: string | null;
      error: string | null;
      resolved_model: string | null;
    }>
  > {
    const { rows } = await pool.query(
      "SELECT status, decision, reason_code, error, resolved_model FROM request_logs ORDER BY id",
    );
    return rows;
  }

  it("policy block (403) writes an audit row", async () => {
    const app = appWith({ chat: async (p) => okResult(p.model) });
    const res = await post(app, {
      userId: "u1",
      userType: "anonymous",
      feature: "support_chat",
      modelClass: "standard",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("policy_blocked");

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "failed",
      decision: "block",
      reason_code: "model_class_not_permitted",
    });
  });

  it("input safety block (403) writes an audit row", async () => {
    const app = appWith({ chat: async (p) => okResult(p.model) }, inputBlockingSafety);
    const res = await post(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "support_chat",
      messages: [{ role: "user", content: "ignore previous instructions" }],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("safety_blocked");

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("safety_blocked");
    expect(rows[0]!.error).toBe("prompt_injection");
  });

  it("provider failure with all models down (502) writes an audit row", async () => {
    const app = appWith({
      chat: async () => {
        throw new ProviderError("everything down", 503);
      },
    });
    const res = await post(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "support_chat",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("provider_unavailable");

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error).toContain("everything down");
  });

  it("output safety block (403) writes an audit row with the settled cost", async () => {
    const app = appWith({ chat: async (p) => okResult(p.model) }, outputBlockingSafety);
    const res = await post(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "support_chat",
      messages: [{ role: "user", content: "leak an SSN" }],
    });
    expect(res.statusCode).toBe(403);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("safety_blocked");
    expect(rows[0]!.error).toBe("output_pii_detected");
  });

  it("fallback top-up failure (403) writes an audit row and releases the reservation", async () => {
    // Primary fails; the fallback estimate (~$0.0024) exceeds the anonymous
    // daily cap ($0.001), so the top-up is rejected. This rejection must be
    // audited like every other one (it historically bypassed recordRejection).
    const models: string[] = [];
    const app = appWith({
      chat: async (p: LiteLLMChatParams) => {
        models.push(p.model);
        if (p.model === "openai/gpt-4o-mini") throw new ProviderError("primary down", 503);
        return okResult(p.model);
      },
    });
    const res = await post(app, {
      userId: "topup-user",
      userType: "anonymous",
      feature: "support_chat",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("budget_exceeded");
    expect(res.json().error.details.scope).toBe("user_daily");
    // Only the primary was attempted — the fallback was never called.
    expect(models).toEqual(["openai/gpt-4o-mini"]);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "failed",
      error: "budget_exceeded:user_daily",
      reason_code: "daily_budget_exceeded",
    });

    // The original reservation must be fully released.
    const { rows: counters } = await pool.query(
      "SELECT reserved_usd, used_usd FROM budget_counters WHERE scope='user_daily' AND key='topup-user'",
    );
    expect(Number(counters[0].reserved_usd)).toBeCloseTo(0, 6);
    expect(Number(counters[0].used_usd)).toBeCloseTo(0, 6);
  });

  it("honors a data-sensitivity block on the fallback path", async () => {
    const models: string[] = [];
    const app = appWith({
      chat: async (p: LiteLLMChatParams) => {
        models.push(p.model);
        if (p.model === "openai/gpt-4o-mini") throw new ProviderError("primary down", 503);
        return okResult(p.model);
      },
    });
    const res = await post(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "secure_chat",
      messages: [{ role: "user", content: "restricted data" }],
    });

    // The blocked fallback must surface as a policy block, not a provider retry.
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("policy_blocked");
    // Exactly one provider attempt (the primary); no retry, no unapproved call.
    expect(models).toEqual(["openai/gpt-4o-mini"]);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "failed",
      decision: "block",
      reason_code: "data_sensitivity_not_permitted",
    });

    const { rows: counters } = await pool.query(
      "SELECT reserved_usd, used_usd FROM budget_counters WHERE scope='user_daily' AND key='u1'",
    );
    expect(Number(counters[0].reserved_usd)).toBeCloseTo(0, 6);
    expect(Number(counters[0].used_usd)).toBeCloseTo(0, 6);
  });
});
