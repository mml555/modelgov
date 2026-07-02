import { describe, expect, it } from "vitest";
import { parseConfigObject } from "@ai-guard/policy-engine";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";
import { mockPool } from "./mockPool";

const config = parseConfigObject({
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 100, hard_stop_at_percent: 100 },
    by_user_type: {
      logged_in: { daily_usd: 1, daily_requests: 10, models: ["cheap", "standard"] },
      admin: { daily_usd: 5, daily_requests: 100, models: ["cheap", "standard", "premium"] },
    },
  },
  features: {
    support_chat: { safety: "strict", model_class: "cheap", max_tokens: 500 },
  },
  model_classes: {
    cheap: { primary: "openai/gpt-4o-mini", fallback: "anthropic/claude-haiku" },
    standard: { primary: "anthropic/claude-sonnet", fallback: "openai/gpt-4o" },
    premium: { primary: "openai/gpt-5", fallback: "anthropic/claude-opus" },
  },
  safety: { preset: "balanced" },
});

function poolMock() {
  return mockPool() as never;
}

function app() {
  return buildServer({
    config,
    pool: poolMock(),
    litellm: { chat: async () => { throw new Error("litellm should not be reached"); } },
    safety: new NoopGuard(),
    observability: new NoopObservability(),
    logger: false,
    apiKey: "secret",
  });
}

describe("POST /v1/explain", () => {
  it("returns a degrade decision without calling LiteLLM", async () => {
    const server = app();
    const res = await server.inject({
      method: "POST",
      url: "/v1/explain",
      headers: { authorization: "Bearer secret" },
      payload: {
        userId: "user_1",
        userType: "logged_in",
        feature: "support_chat",
        modelClass: "premium",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.decision).toBe("block");
    expect(body.reason).toContain("premium");
    expect(body.wouldCallModel).toBe(false);
    expect(body.summary).toContain("Decision:");
    expect(body.resolved.model).toBeTruthy();
    await server.close();
  });

  it("allows permitted model classes", async () => {
    const server = app();
    const res = await server.inject({
      method: "POST",
      url: "/v1/explain",
      headers: { authorization: "Bearer secret" },
      payload: {
        userId: "user_1",
        userType: "logged_in",
        feature: "support_chat",
        modelClass: "cheap",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.decision).toBe("allow");
    expect(body.wouldCallModel).toBe(true);
    expect(body.resolved.modelClass).toBe("cheap");
    await server.close();
  });

  it("rejects unknown features with 400", async () => {
    const server = app();
    const res = await server.inject({
      method: "POST",
      url: "/v1/explain",
      headers: { authorization: "Bearer secret" },
      payload: {
        userId: "user_1",
        userType: "logged_in",
        feature: "unknown_feature",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("unknown_feature");
    await server.close();
  });

  it("requires authentication", async () => {
    const server = app();
    const res = await server.inject({
      method: "POST",
      url: "/v1/explain",
      payload: {
        userId: "user_1",
        userType: "logged_in",
        feature: "support_chat",
      },
    });

    expect(res.statusCode).toBe(401);
    await server.close();
  });
});
