import { parseConfigObject } from "@modelgov/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";

const DATABASE_URL = process.env.DATABASE_URL;

// estimate = default input 500 + maxOutputTokens 50 = 550 tokens.
function config(over: Record<string, unknown>) {
  return parseConfigObject({
    project: { name: "test", environment: "test" },
    budgets: {
      global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
      by_user_type: { logged_in: { daily_usd: 1000, daily_requests: 1000, models: ["cheap"] } },
    },
    features: { chat: { safety: "dev", model_class: "cheap", max_tokens: 50 } },
    model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
    safety: { preset: "dev" },
    ...over,
  });
}

describe.skipIf(!DATABASE_URL)("token-based limiting (integration)", () => {
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

  function app(cfg: ReturnType<typeof config>): FastifyInstance {
    return buildServer({
      config: cfg,
      pool,
      // Fake provider returns known token usage (input 400 + output 30 = 430).
      litellm: { chat: async () => ({ content: "ok", model: "openai/gpt-4o-mini", actualCostUsd: 0.001, inputTokens: 400, outputTokens: 30, raw: {} }) },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKey: "secret",
    });
  }

  const body = { userId: "u1", userType: "logged_in", feature: "chat", messages: [{ role: "user", content: "hi" }] };
  const post = (server: FastifyInstance) =>
    server.inject({ method: "POST", url: "/v1/chat", headers: { authorization: "Bearer secret" }, payload: body });

  it("blocks when the token estimate exceeds a user daily token cap", async () => {
    const cfg = config({
      budgets: {
        global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
        by_user_type: { logged_in: { daily_usd: 1000, daily_requests: 1000, models: ["cheap"], daily_tokens: 400 } },
      },
    });
    const res = await post(app(cfg));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.reasonCode).toBe("daily_token_limit_reached");
  });

  it("allows within the token cap and settles actual tokens used", async () => {
    const cfg = config({
      budgets: {
        global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
        by_user_type: { logged_in: { daily_usd: 1000, daily_requests: 1000, models: ["cheap"], daily_tokens: 5000 } },
      },
    });
    const res = await post(app(cfg));
    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query("SELECT used_tokens, reserved_tokens FROM budget_counters WHERE scope='user_daily'");
    expect(Number(rows[0].used_tokens)).toBe(430); // actual input+output
    expect(Number(rows[0].reserved_tokens)).toBe(0); // reservation settled
  });

  it("enforces a token limit across multiple requests", async () => {
    // cap 1000: est 550 each → first allowed (settles 430 used), second allowed
    // (430 + 550 = 980 <= 1000), third blocked (860 + 550 > 1000).
    const cfg = config({
      budgets: {
        global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
        by_user_type: { logged_in: { daily_usd: 1000, daily_requests: 1000, models: ["cheap"], daily_tokens: 1000 } },
      },
    });
    const server = app(cfg);
    expect((await post(server)).statusCode).toBe(200);
    expect((await post(server)).statusCode).toBe(200);
    const third = await post(server);
    expect(third.statusCode).toBe(403);
    expect(third.json().error.details.reasonCode).toBe("daily_token_limit_reached");
  });

  it("blocks on a global monthly token cap", async () => {
    const cfg = config({
      budgets: {
        global: { monthly_usd: 1000, hard_stop_at_percent: 100, monthly_tokens: 400 },
        by_user_type: { logged_in: { daily_usd: 1000, daily_requests: 1000, models: ["cheap"] } },
      },
    });
    const res = await post(app(cfg));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.reasonCode).toBe("global_monthly_token_limit_reached");
  });
});
