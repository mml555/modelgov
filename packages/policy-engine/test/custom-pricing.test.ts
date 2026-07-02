import { describe, expect, it } from "vitest";
import { parseConfigObject } from "../src/config";
import { estimateCostUsd, findUnpricedModels, getModelPrice } from "../src/cost";
import { evaluateAiRequest } from "../src/evaluator";
import type { UsageSnapshot } from "../src/types";

const ZERO: UsageSnapshot = {
  userDailyUsdUsed: 0, userDailyUsdReserved: 0, userDailyRequestsUsed: 0,
  featureMonthlyUsdUsed: 0, featureMonthlyUsdReserved: 0,
  globalMonthlyUsdUsed: 0, globalMonthlyUsdReserved: 0,
};

describe("custom pricing", () => {
  it("getModelPrice: override wins over table wins over default", () => {
    const over = { "openrouter/foo": { inputPer1k: 1, outputPer1k: 2 } };
    expect(getModelPrice("openrouter/foo", over)).toEqual({ inputPer1k: 1, outputPer1k: 2 });
    expect(getModelPrice("openai/gpt-4o-mini", over).inputPer1k).toBe(0.00015); // built-in table
    expect(getModelPrice("mystery/model")).toEqual({ inputPer1k: 0.001, outputPer1k: 0.004 }); // default
  });

  it("estimateCostUsd uses the override for an otherwise-unknown model", () => {
    // 1000 input + 1000 output at $10/$20 per 1k = 10 + 20 = 30.
    const over = { "vendor/big": { inputPer1k: 10, outputPer1k: 20 } };
    expect(estimateCostUsd("vendor/big", 1000, 1000, over)).toBeCloseTo(30, 6);
    // Without the override, the conservative default applies (much lower).
    expect(estimateCostUsd("vendor/big", 1000, 1000)).toBeLessThan(30);
  });

  it("config `pricing` flows into the reservation estimate + blocks correctly", () => {
    const config = parseConfigObject({
      project: { name: "t", environment: "test" },
      budgets: {
        global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
        by_user_type: { logged_in: { daily_usd: 0.5, daily_requests: 100, models: ["cheap"] } },
      },
      features: { chat: { safety: "dev", model_class: "cheap", max_tokens: 1000 } },
      model_classes: { cheap: { primary: "openrouter/pricey" } },
      safety: { preset: "dev" },
      pricing: { "openrouter/pricey": { input_per_1k: 1, output_per_1k: 1 } },
    });
    // est = (500/1000)*1 + (1000/1000)*1 = 0.5 + 1 = 1.5 > daily_usd 0.5 → block.
    const d = evaluateAiRequest({ request: { projectId: "p", environment: "test", userId: "u", userType: "logged_in", feature: "chat" }, config, usage: ZERO });
    expect(d.decision).toBe("block");
    expect(d.reasonCode).toBe("daily_budget_exceeded");
    expect(d.estimatedCostUsd).toBeCloseTo(1.5, 6);
  });

  it("a custom-priced model is not reported as unpriced", () => {
    const config = parseConfigObject({
      project: { name: "t", environment: "test" },
      budgets: { global: { monthly_usd: 100, hard_stop_at_percent: 100 }, by_user_type: { u: { daily_usd: 1, daily_requests: 1, models: ["cheap"] } } },
      features: { f: { model_class: "cheap", max_tokens: 10, safety: "dev" } },
      model_classes: { cheap: { primary: "azure/my-deployment" } },
      safety: { preset: "dev" },
      pricing: { "azure/my-deployment": { input_per_1k: 0.002, output_per_1k: 0.008 } },
    });
    expect(findUnpricedModels(config)).not.toContain("azure/my-deployment");
  });

  it("rejects negative prices", () => {
    expect(() =>
      parseConfigObject({
        project: { name: "t", environment: "test" },
        budgets: { global: { monthly_usd: 100, hard_stop_at_percent: 100 }, by_user_type: { u: { daily_usd: 1, daily_requests: 1, models: ["cheap"] } } },
        features: { f: { model_class: "cheap", max_tokens: 10, safety: "dev" } },
        model_classes: { cheap: { primary: "x/y" } },
        safety: { preset: "dev" },
        pricing: { "x/y": { input_per_1k: -1, output_per_1k: 1 } },
      }),
    ).toThrow();
  });
});
