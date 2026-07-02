import { describe, expect, it } from "vitest";
import { evaluateAiRequest } from "../src/evaluator";
import { PolicyConfigError } from "../src/types";
import { baseConfig, request, usage } from "./helpers";

const config = baseConfig();

describe("evaluateAiRequest — allow", () => {
  it("allows a request under budget and resolves the primary model", () => {
    const d = evaluateAiRequest({
      request: request(),
      config,
      usage: usage(),
    });
    expect(d.decision).toBe("allow");
    expect(d.resolvedModelClass).toBe("cheap");
    expect(d.resolvedModel).toBe("openai/gpt-4o-mini");
    expect(d.resolvedProvider).toBe("openai");
    expect(d.fallbackModel).toBe("anthropic/claude-haiku");
    // gpt-4o-mini: 500 input * 0.00015/1k + 500 output * 0.0006/1k
    expect(d.estimatedCostUsd).toBeCloseTo(0.000375, 9);
    expect(d.maxOutputTokens).toBe(500);
    expect(d.traceTags).toEqual({
      userId: "user-1",
      feature: "support_chat",
      modelClass: "cheap",
      policyDecision: "allow",
    });
  });

  it("lets requestedModelClass override the feature default", () => {
    const d = evaluateAiRequest({
      request: request({ requestedModelClass: "standard" }),
      config,
      usage: usage(),
    });
    expect(d.decision).toBe("allow");
    expect(d.resolvedModelClass).toBe("standard");
    expect(d.resolvedModel).toBe("anthropic/claude-sonnet");
  });

  it("reports budgetRemaining headroom", () => {
    const d = evaluateAiRequest({
      request: request(),
      config,
      usage: usage({ userDailyUsdUsed: 0.1 }),
    });
    expect(d.budgetRemaining.userDailyUsd).toBeCloseTo(0.15, 9);
    expect(d.budgetRemaining.featureMonthlyUsd).toBeNull();
    expect(d.budgetRemaining.globalMonthlyUsd).toBeCloseTo(100, 9);
  });

  it("outputTokensEstimate:0 (embeddings) drops the completion term from the estimate", () => {
    const withOutput = evaluateAiRequest({
      request: request({ inputTokensEstimate: 1000 }),
      config,
      usage: usage(),
    });
    const embeddings = evaluateAiRequest({
      request: request({ inputTokensEstimate: 1000, outputTokensEstimate: 0 }),
      config,
      usage: usage(),
    });
    // support_chat: max_tokens 500, so chat reserves 1000 + 500 tokens; embeddings
    // must reserve only the 1000 input tokens (no phantom output).
    expect(withOutput.estimatedTokens).toBe(1500);
    expect(embeddings.estimatedTokens).toBe(1000);
    // gpt-4o-mini: 1000 input * 0.00015/1k, no output term.
    expect(embeddings.estimatedCostUsd).toBeCloseTo(0.00015, 9);
  });
});

describe("evaluateAiRequest — block", () => {
  it("blocks when the daily request count is exhausted", () => {
    const d = evaluateAiRequest({
      request: request(),
      config,
      usage: usage({ userDailyRequestsUsed: 50 }),
    });
    expect(d.decision).toBe("block");
    expect(d.reason).toMatch(/daily request limit/i);
  });

  it("blocks when used + reserved + estimate exceeds the daily USD cap", () => {
    const d = evaluateAiRequest({
      request: request(),
      config,
      usage: usage({ userDailyUsdUsed: 0.25 }),
    });
    expect(d.decision).toBe("block");
    expect(d.reason).toMatch(/daily budget/i);
  });

  it("counts reserved spend toward the cap (concurrent-leak guard)", () => {
    const d = evaluateAiRequest({
      request: request(),
      config,
      usage: usage({ userDailyUsdUsed: 0.24, userDailyUsdReserved: 0.01 }),
    });
    expect(d.decision).toBe("block");
  });

  it("blocks at the global monthly hard stop", () => {
    const d = evaluateAiRequest({
      request: request(),
      config,
      usage: usage({ globalMonthlyUsdUsed: 100 }),
    });
    expect(d.decision).toBe("block");
    expect(d.reason).toMatch(/global monthly budget/i);
  });

  it("blocks when the feature monthly cap is exceeded", () => {
    const d = evaluateAiRequest({
      request: request({ feature: "capped_feature" }),
      config,
      usage: usage({ featureMonthlyUsdUsed: 1 }),
    });
    expect(d.decision).toBe("block");
    expect(d.reason).toMatch(/feature monthly budget/i);
  });

  it("blocks a model class the user type may not use", () => {
    const d = evaluateAiRequest({
      request: request({ userType: "anonymous", requestedModelClass: "standard" }),
      config,
      usage: usage(),
    });
    expect(d.decision).toBe("block");
    expect(d.reason).toMatch(/not permitted/i);
  });
});

describe("evaluateAiRequest — degrade", () => {
  it("degrades one tier when global spend crosses the threshold", () => {
    const d = evaluateAiRequest({
      request: request({ userType: "admin", feature: "premium_feature" }),
      config,
      usage: usage({ globalMonthlyUsdUsed: 85 }), // 85% > 80% degrade threshold
    });
    expect(d.decision).toBe("degrade");
    expect(d.resolvedModelClass).toBe("standard"); // premium -> standard, exactly one tier
    expect(d.resolvedModel).toBe("anthropic/claude-sonnet");
    expect(d.reason).toMatch(/degraded/i);
  });

  it("does not degrade when there is no cheaper permitted class", () => {
    // cheap is already the cheapest tier — stays put, then blocks on hard stop
    const d = evaluateAiRequest({
      request: request(),
      config,
      usage: usage({ globalMonthlyUsdUsed: 85 }),
    });
    expect(d.decision).toBe("allow");
    expect(d.resolvedModelClass).toBe("cheap");
  });
});

describe("evaluateAiRequest — fallback", () => {
  it("resolves the fallback model and skips budget gates", () => {
    const d = evaluateAiRequest({
      request: request({ forceFallback: true }),
      config,
      // way over every budget — fallback must still resolve (already in flight)
      usage: usage({
        userDailyUsdUsed: 999,
        userDailyRequestsUsed: 999,
        globalMonthlyUsdUsed: 999,
      }),
    });
    expect(d.decision).toBe("fallback");
    expect(d.resolvedModel).toBe("anthropic/claude-haiku");
    expect(d.resolvedProvider).toBe("anthropic");
  });
});

describe("evaluateAiRequest — safety plan", () => {
  it("uses the feature's safety preset override (strict)", () => {
    const d = evaluateAiRequest({ request: request(), config, usage: usage() });
    expect(d.safetyPreset).toBe("strict");
    expect(d.safetyPlan.pii).toBe("block");
    expect(d.safetyPlan.promptInjection).toBe("block");
    expect(d.safetyPlan.injectionModel).toBe("openai/gpt-4o-mini");
    expect(d.safetyPlan.maxOutputTokens).toBe(500);
  });

  it("falls back to the global preset when the feature sets none (balanced)", () => {
    const d = evaluateAiRequest({
      request: request({ userType: "admin", feature: "premium_feature" }),
      config,
      usage: usage(),
    });
    expect(d.safetyPreset).toBe("balanced");
    expect(d.safetyPlan.pii).toBe("mask");
    expect(d.safetyPlan.maxOutputTokens).toBe(1000);
  });
});

describe("evaluateAiRequest — contract violations throw", () => {
  it("throws on an unknown feature", () => {
    expect(() =>
      evaluateAiRequest({
        request: request({ feature: "nope" }),
        config,
        usage: usage(),
      }),
    ).toThrow(PolicyConfigError);
  });

  it("throws on an unknown model class", () => {
    expect(() =>
      evaluateAiRequest({
        request: request({ requestedModelClass: "ultra" }),
        config,
        usage: usage(),
      }),
    ).toThrow(/unknown model_class/);
  });

  it("throws on an unknown user type", () => {
    expect(() =>
      evaluateAiRequest({
        request: request({ userType: "robot" }),
        config,
        usage: usage(),
      }),
    ).toThrow(/unknown user_type/);
  });
});
