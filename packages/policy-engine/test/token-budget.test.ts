import { describe, expect, it } from "vitest";
import { parseConfigObject } from "../src/config";
import { evaluateAiRequest } from "../src/evaluator";
import type { UsageSnapshot } from "../src/types";

const ZERO: UsageSnapshot = {
  userDailyUsdUsed: 0, userDailyUsdReserved: 0, userDailyRequestsUsed: 0,
  featureMonthlyUsdUsed: 0, featureMonthlyUsdReserved: 0,
  globalMonthlyUsdUsed: 0, globalMonthlyUsdReserved: 0,
};

// estimate = default input (500) + maxOutputTokens (50) = 550 tokens.
function config(over: Record<string, unknown> = {}) {
  return parseConfigObject({
    project: { name: "t", environment: "test" },
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

const req = { projectId: "p", environment: "test", userId: "u", userType: "logged_in", feature: "chat" };

describe("token limiting (engine)", () => {
  it("has no token gate when no token cap is set", () => {
    const d = evaluateAiRequest({ request: req, config: config(), usage: ZERO });
    expect(d.decision).toBe("allow");
    expect(d.estimatedTokens).toBe(550);
    expect(d.reservationCaps.userDailyTokens ?? null).toBeNull();
  });

  it("blocks on a user daily token cap the estimate would exceed", () => {
    const cfg = config({
      budgets: {
        global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
        by_user_type: { logged_in: { daily_usd: 1000, daily_requests: 1000, models: ["cheap"], daily_tokens: 400 } },
      },
    });
    const d = evaluateAiRequest({ request: req, config: cfg, usage: ZERO });
    expect(d.decision).toBe("block");
    expect(d.reasonCode).toBe("daily_token_limit_reached");
    expect(d.budgetRemaining.userDailyTokens).toBe(400);
  });

  it("allows when used + estimate fits the token cap, and reports remaining", () => {
    const cfg = config({
      budgets: {
        global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
        by_user_type: { logged_in: { daily_usd: 1000, daily_requests: 1000, models: ["cheap"], daily_tokens: 1000 } },
      },
    });
    const d = evaluateAiRequest({ request: req, config: cfg, usage: { ...ZERO, userDailyTokensUsed: 400 } });
    expect(d.decision).toBe("allow"); // 400 + 550 <= 1000
    expect(d.budgetRemaining.userDailyTokens).toBe(600);
  });

  it("blocks on a feature monthly token cap", () => {
    const cfg = config({
      features: { chat: { safety: "dev", model_class: "cheap", max_tokens: 50, budget: { monthly_tokens: 400 } } },
    });
    const d = evaluateAiRequest({ request: req, config: cfg, usage: ZERO });
    expect(d.reasonCode).toBe("feature_monthly_token_limit_reached");
  });

  it("blocks on a global monthly token cap", () => {
    const cfg = config({
      budgets: {
        global: { monthly_usd: 1000, hard_stop_at_percent: 100, monthly_tokens: 400 },
        by_user_type: { logged_in: { daily_usd: 1000, daily_requests: 1000, models: ["cheap"] } },
      },
    });
    const d = evaluateAiRequest({ request: req, config: cfg, usage: ZERO });
    expect(d.reasonCode).toBe("global_monthly_token_limit_reached");
  });
});
