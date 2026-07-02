import { describe, expect, it } from "vitest";
import { parseConfigObject } from "../src/config";
import { evaluateAiRequest } from "../src/evaluator";
import { nextPermittedCheaperClass } from "../src/routing";
import { PolicyConfigError } from "../src/types";

// Global spend already past the degrade threshold so `degrade` triggers.
const usageOverThreshold = {
  userDailyUsdUsed: 0,
  userDailyUsdReserved: 0,
  userDailyRequestsUsed: 0,
  featureMonthlyUsdUsed: 0,
  featureMonthlyUsdReserved: 0,
  globalMonthlyUsdUsed: 90,
  globalMonthlyUsdReserved: 0,
};

function cfg(raw: Record<string, unknown>) {
  return parseConfigObject({
    project: { name: "t", environment: "test" },
    budgets: {
      global: { monthly_usd: 100, hard_stop_at_percent: 100 },
      by_user_type: { logged_in: { daily_usd: 10, daily_requests: 100, models: ["nano", "cheap", "standard"] } },
    },
    features: { chat: { safety: "dev", model_class: "standard", max_tokens: 50 } },
    model_classes: {
      nano: { primary: "openai/gpt-4o-mini" },
      cheap: { primary: "openai/gpt-4o-mini" },
      standard: { primary: "anthropic/claude-sonnet" },
    },
    routing: { degrade_at_percent: 80 },
    safety: { preset: "dev" },
    ...raw,
  });
}

const req = { projectId: "p", environment: "test", userId: "u", userType: "logged_in", feature: "chat" };

describe("configurable routing order", () => {
  it("defaults to the built-in tier order when class_order is absent", () => {
    // Default order is cheap→standard→premium; 'nano' is not in it → not a
    // degrade target. From 'standard', the cheaper permitted class is 'cheap'.
    const config = cfg({});
    const d = evaluateAiRequest({ request: req, config, usage: usageOverThreshold });
    expect(d.decision).toBe("degrade");
    expect(d.resolvedModelClass).toBe("cheap");
  });

  it("uses a custom class_order for the degrade step", () => {
    // Custom order makes 'nano' the cheapest tier below 'cheap' below 'standard'.
    const config = cfg({ routing: { degrade_at_percent: 80, class_order: ["nano", "cheap", "standard"] } });
    const d = evaluateAiRequest({ request: req, config, usage: usageOverThreshold });
    expect(d.decision).toBe("degrade");
    // Degrade steps down ONE tier from 'standard' → 'cheap'.
    expect(d.resolvedModelClass).toBe("cheap");
  });

  it("respects a reordered tier list", () => {
    // Order where 'nano' sits directly below 'standard' (cheap excluded/after).
    const config = cfg({ routing: { degrade_at_percent: 80, class_order: ["nano", "standard", "cheap"] } });
    // From 'standard', the next cheaper in this order is 'nano'.
    expect(nextPermittedCheaperClass("standard", ["nano", "cheap", "standard"], config)).toBe("nano");
  });

  it("rejects class_order referencing an unknown model_class", () => {
    expect(() => cfg({ routing: { degrade_at_percent: 80, class_order: ["nano", "ghost"] } })).toThrow(PolicyConfigError);
  });

  it("returns null when the current class is cheapest in the order", () => {
    const config = cfg({ routing: { degrade_at_percent: 80, class_order: ["nano", "cheap", "standard"] } });
    expect(nextPermittedCheaperClass("nano", ["nano", "cheap"], config)).toBeNull();
  });
});
