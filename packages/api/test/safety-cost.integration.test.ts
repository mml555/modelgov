import { parseConfigObject, type SafetyPlan } from "@ai-guard/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import type { ChatMessage } from "../src/types";
import type { OutputSafetyResult, SafetyGuard, SafetyResult } from "../src/services/safety";
import { NoopObservability } from "../src/services/observability";
import { ProviderError, type LiteLLMClient } from "../src/services/litellm";
import { buildServer } from "../src/server";

const DATABASE_URL = process.env.DATABASE_URL;

// Input estimate ≈ $0.0975 (650k tokens × $0.00015/1k) + tiny output.
const INPUT_TOKENS = 650_000;
const SAFETY_COST = 0.1;

/** Safety guard that charges a fixed classifier cost but allows the request. */
class CostlySafety implements SafetyGuard {
  async inspectInput(messages: ChatMessage[], _plan: SafetyPlan): Promise<SafetyResult> {
    return { action: "allow", messages, piiMasked: false, injectionBlocked: false, findings: [], safetyCostUsd: SAFETY_COST };
  }
  async inspectOutput(content: string, _plan: SafetyPlan): Promise<OutputSafetyResult> {
    return { action: "allow", content, piiMasked: false, findings: [] };
  }
}

/** Safety guard that charges the classifier cost AND blocks the input. */
class CostlyBlockingSafety implements SafetyGuard {
  async inspectInput(messages: ChatMessage[], _plan: SafetyPlan): Promise<SafetyResult> {
    return {
      action: "block",
      messages,
      piiMasked: false,
      injectionBlocked: true,
      findings: [{ type: "prompt_injection", detail: "test" }],
      blockReason: "prompt_injection",
      safetyCostUsd: SAFETY_COST,
    };
  }
  async inspectOutput(content: string, _plan: SafetyPlan): Promise<OutputSafetyResult> {
    return { action: "allow", content, piiMasked: false, findings: [] };
  }
}

function config(dailyUsd: number, fallback?: string) {
  return parseConfigObject({
    project: { name: "test", environment: "test" },
    budgets: {
      global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
      by_user_type: { logged_in: { daily_usd: dailyUsd, daily_requests: 100, models: ["cheap"] } },
    },
    features: { support_chat: { safety: "dev", model_class: "cheap", max_tokens: 50 } },
    model_classes: { cheap: { primary: "openai/gpt-4o-mini", ...(fallback ? { fallback } : {}) } },
    safety: { preset: "dev" },
  });
}

describe.skipIf(!DATABASE_URL)("safety cost is reserved upfront (integration)", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE budget_counters, request_logs, budget_reservation_leases");
  });

  function app(
    dailyUsd: number,
    overrides: { litellm?: LiteLLMClient; safety?: SafetyGuard } = {},
  ): FastifyInstance {
    return buildServer({
      config: config(dailyUsd),
      pool,
      litellm: overrides.litellm ?? {
        chat: async () => ({ content: "ok", model: "openai/gpt-4o-mini", actualCostUsd: 0.0975, inputTokens: 650000, outputTokens: 10, raw: {} }),
      },
      safety: overrides.safety ?? new CostlySafety(),
      observability: new NoopObservability(),
      logger: false,
      apiKey: "secret",
    });
  }

  async function userDailyCounter(): Promise<{ used: number; reserved: number }> {
    const { rows } = await pool.query(
      "SELECT used_usd, reserved_usd FROM budget_counters WHERE scope = 'user_daily'",
    );
    return rows.length === 0
      ? { used: 0, reserved: 0 }
      : { used: Number(rows[0].used_usd), reserved: Number(rows[0].reserved_usd) };
  }

  const body = {
    userId: "u1", userType: "logged_in", feature: "support_chat",
    messages: [{ role: "user", content: "hi" }], inputTokensEstimate: INPUT_TOKENS,
  };

  function post(server: FastifyInstance) {
    return server.inject({ method: "POST", url: "/v1/chat", headers: { authorization: "Bearer secret" }, payload: body });
  }

  it("blocks when model estimate fits but model + safety exceeds the cap — and still books the safety spend", async () => {
    // cap 0.15: model (~0.0975) alone fits, but model + safety (~0.1975) does not.
    const res = await post(app(0.15));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("budget_exceeded");
    // The reservation rolled back, but the classifier call already happened:
    // its cost lands in used_usd (no cap check — booking never gates), with
    // nothing left reserved.
    const c = await userDailyCounter();
    expect(c.used).toBeCloseTo(SAFETY_COST, 4);
    expect(c.reserved).toBeCloseTo(0, 6);
  });

  it("admits when the cap covers model + safety, and settles both", async () => {
    const res = await post(app(0.3));
    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query(
      "SELECT used_usd FROM budget_counters WHERE scope = 'user_daily'",
    );
    // settled used = model actual (0.0975) + safety (0.10) ≈ 0.1975
    expect(Number(rows[0].used_usd)).toBeCloseTo(0.1975, 4);
  });

  it("books the classifier cost when input safety BLOCKS the request", async () => {
    let providerCalls = 0;
    const res = await post(
      app(10, {
        safety: new CostlyBlockingSafety(),
        litellm: {
          chat: async () => {
            providerCalls++;
            return { content: "ok", model: "openai/gpt-4o-mini", actualCostUsd: 0.0975, raw: {} };
          },
        },
      }),
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("safety_blocked");
    expect(providerCalls).toBe(0); // blocked before any model call

    // The scan was real spend: booked to used_usd with no reservation residue.
    const c = await userDailyCounter();
    expect(c.used).toBeCloseTo(SAFETY_COST, 4);
    expect(c.reserved).toBeCloseTo(0, 6);

    // The audit row carries the incurred cost.
    const { rows } = await pool.query(
      "SELECT status, actual_cost_usd FROM request_logs",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("safety_blocked");
    expect(Number(rows[0].actual_cost_usd)).toBeCloseTo(SAFETY_COST, 4);
  });

  it("books the safety spend when the fallback top-up exceeds the cap", async () => {
    // cap 0.25 admits primary + safety (~0.1975); the fallback estimate
    // (claude-haiku at 650k input ≈ $0.52) forces a top-up to ~0.62 which the
    // cap rejects. Historically this branch released the reservation WITHOUT
    // booking the classifier spend — the one rejection path 1.3 missed.
    let fallbackCalled = false;
    const server = buildServer({
      config: config(0.25, "anthropic/claude-haiku"),
      pool,
      litellm: {
        chat: async (p) => {
          if (p.model === "openai/gpt-4o-mini") throw new ProviderError("primary down", 503);
          fallbackCalled = true;
          return { content: "ok", model: p.model, actualCostUsd: 0.52, raw: {} };
        },
      },
      safety: new CostlySafety(),
      observability: new NoopObservability(),
      logger: false,
      apiKey: "secret",
    });
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("budget_exceeded");
    expect(fallbackCalled).toBe(false); // top-up rejected before the fallback call

    const c = await userDailyCounter();
    expect(c.used).toBeCloseTo(SAFETY_COST, 4);
    expect(c.reserved).toBeCloseTo(0, 6);

    const { rows } = await pool.query("SELECT status, actual_cost_usd FROM request_logs");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(Number(rows[0].actual_cost_usd)).toBeCloseTo(SAFETY_COST, 4);
  });

  it("retains the safety spend when the provider fails after reservation", async () => {
    const res = await post(
      app(0.3, {
        litellm: {
          chat: async () => {
            throw new ProviderError("provider down", 503);
          },
        },
      }),
    );
    expect(res.statusCode).toBe(502);
    // Model portion released, safety portion kept as used.
    const c = await userDailyCounter();
    expect(c.used).toBeCloseTo(SAFETY_COST, 4);
    expect(c.reserved).toBeCloseTo(0, 6);

    const { rows } = await pool.query(
      "SELECT status, actual_cost_usd FROM request_logs",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(Number(rows[0].actual_cost_usd)).toBeCloseTo(SAFETY_COST, 4);
  });
});
