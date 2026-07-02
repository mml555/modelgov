import { describe, expect, it } from "vitest";
import { explainLocally } from "../src/explain.js";
import { parseConfigObject } from "@ai-guard/policy-engine";

const config = parseConfigObject({
  project: { name: "saas-demo", environment: "development" },
  budgets: {
    global: { monthly_usd: 500, hard_stop_at_percent: 100 },
    by_user_type: {
      free_user: { daily_usd: 0.05, daily_requests: 20, models: ["cheap"] },
      paid_user: { daily_usd: 0.5, daily_requests: 100, models: ["cheap", "standard"] },
    },
  },
  features: {
    support_chat: { safety: "strict", model_class: "cheap", max_tokens: 500 },
  },
  model_classes: {
    cheap: { primary: "openai/gpt-4o-mini" },
    standard: { primary: "anthropic/claude-sonnet" },
  },
  safety: { preset: "balanced" },
});

describe("ai-guard explain --local", () => {
  it("blocks premium for free users", () => {
    const body = explainLocally(config, {
      userId: "u1",
      userType: "free_user",
      feature: "support_chat",
      modelClass: "standard",
      configPath: "",
      local: true,
      baseUrl: "",
      json: false,
    });

    expect(body.decision).toBe("block");
    expect(body.wouldCallModel).toBe(false);
    expect(String(body.summary)).toContain("Decision: block");
  });

  it("allows cheap for paid users", () => {
    const body = explainLocally(config, {
      userId: "u1",
      userType: "paid_user",
      feature: "support_chat",
      modelClass: "standard",
      configPath: "",
      local: true,
      baseUrl: "",
      json: false,
    });

    expect(body.decision).toBe("allow");
    expect(body.wouldCallModel).toBe(true);
  });
});
