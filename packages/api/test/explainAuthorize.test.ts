import { describe, expect, it } from "vitest";
import { authorizeExplainInput } from "../src/modules/explain/authorize";
import { formatExplainSummary, wouldCallModel } from "../src/modules/explain/format";
import type { ExplainResponse } from "../src/modules/explain/types";

describe("authorizeExplainInput", () => {
  const body = {
    userId: "u1",
    userType: "logged_in",
    feature: "support_chat",
  };

  it("allows keys with chat:create", () => {
    const result = authorizeExplainInput(
      { permissions: ["chat:create"] } as never,
      body,
    );
    expect(result.ok).toBe(true);
  });

  it("allows keys with policy:explain only", () => {
    const result = authorizeExplainInput(
      { permissions: ["policy:explain"] } as never,
      body,
    );
    expect(result.ok).toBe(true);
  });

  it("denies keys without chat:create or policy:explain", () => {
    const result = authorizeExplainInput(
      { apiKeyName: "ops", permissions: ["usage:read"] } as never,
      body,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.code).toBe("forbidden");
    }
  });

  it("denies cross-project access", () => {
    const result = authorizeExplainInput(
      {
        permissions: ["chat:create"],
        projectId: "tenant-a",
      } as never,
      { ...body, projectId: "tenant-b" },
    );
    expect(result.ok).toBe(false);
  });

  it("merges project and environment from the key", () => {
    const result = authorizeExplainInput(
      {
        permissions: ["chat:create"],
        projectId: "proj-1",
        environment: "staging",
      } as never,
      body,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.projectId).toBe("proj-1");
      expect(result.value.environment).toBe("staging");
    }
  });
});

describe("formatExplainSummary", () => {
  const base: ExplainResponse = {
    decision: "allow",
    reason: undefined,
    requested: {
      userId: "u1",
      userType: "logged_in",
      feature: "support_chat",
      modelClass: "cheap",
    },
    resolved: { modelClass: "cheap", model: "openai/gpt-4o-mini", provider: "openai" },
    budget: {
      remaining: { userDailyUsd: 0.25, featureMonthlyUsd: 10, globalMonthlyUsd: 100 },
      used: {
        userDailyUsd: 0,
        userDailyRequests: 1,
        featureMonthlyUsd: 0,
        globalMonthlyUsd: 0,
      },
      permittedModels: ["cheap", "standard"],
      dailyRequestsRemaining: 49,
      dailyRequestLimit: 50,
    },
    safety: { preset: "balanced", pii: "mask", promptInjection: "block", maxOutputTokens: 500 },
    cost: { estimatedUsd: 0.0001 },
    wouldCallModel: true,
    summary: "",
  };

  it("formats an allow decision with budget and safety lines", () => {
    const summary = formatExplainSummary(base);
    expect(summary).toContain("Decision: allow");
    expect(summary).toContain("Model: openai/gpt-4o-mini");
    expect(summary).toContain("Safety: balanced");
    expect(summary).toContain("would proceed to the model");
  });

  it("includes degrade and fallback messaging", () => {
    expect(formatExplainSummary({ ...base, decision: "degrade" })).toContain("downgraded");
    expect(formatExplainSummary({ ...base, decision: "fallback" })).toContain("fallback model");
    expect(formatExplainSummary({ ...base, decision: "block", wouldCallModel: false })).toContain(
      "blocked before calling",
    );
  });

  it("shows resolved class when it differs from requested", () => {
    const summary = formatExplainSummary({
      ...base,
      requested: { ...base.requested, modelClass: "premium" },
      resolved: { ...base.resolved, modelClass: "cheap" },
    });
    expect(summary).toContain("Resolved class: cheap");
  });
});

describe("wouldCallModel", () => {
  it("returns false only for block decisions", () => {
    expect(wouldCallModel("allow")).toBe(true);
    expect(wouldCallModel("degrade")).toBe(true);
    expect(wouldCallModel("fallback")).toBe(true);
    expect(wouldCallModel("block")).toBe(false);
  });
});
