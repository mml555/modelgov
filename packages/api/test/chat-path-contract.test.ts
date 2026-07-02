import { describe, expect, it } from "vitest";
import { parseConfigObject } from "@ai-guard/policy-engine";
import { buildServer } from "../src/server";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { mockPool } from "./mockPool";

const config = parseConfigObject({
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 100, hard_stop_at_percent: 100 },
    by_user_type: {
      logged_in: { daily_usd: 1, daily_requests: 10, models: ["cheap"] },
    },
  },
  features: {
    support_chat: { safety: "strict", model_class: "cheap", max_tokens: 100 },
  },
  model_classes: {
    cheap: { primary: "openai/gpt-4o-mini" },
    standard: { primary: "anthropic/claude-sonnet" },
  },
  safety: { preset: "strict", protect: { pii: "block", prompt_injection: "block" } },
});

const payload = {
  userId: "u1",
  userType: "logged_in",
  feature: "support_chat",
  messages: [{ role: "user", content: "hi" }],
};

function app() {
  return buildServer({
    config,
    pool: mockPool() as never,
    litellm: {
      chat: async () => ({
        content: "ok",
        model: "openai/gpt-4o-mini",
        actualCostUsd: 0.0001,
        raw: {},
      }),
    },
    safety: new NoopGuard(),
    observability: new NoopObservability(),
    logger: false,
    apiKey: "secret",
  });
}

/** Shared error envelope fields every chat rejection must expose. */
const REQUIRED_ERROR_FIELDS = [
  "code",
  "message",
  "requestId",
  "details",
] as const;

describe("chat path contract", () => {
  it("policy_blocked responses include stable correlation fields", async () => {
    const server = app();
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: { ...payload, modelClass: "standard" },
    });
    expect(res.statusCode).toBe(403);
    const err = res.json().error;
    for (const field of REQUIRED_ERROR_FIELDS) {
      expect(err[field], field).toBeDefined();
    }
    expect(err.code).toBe("policy_blocked");
    expect(err).not.toHaveProperty("feature");
    expect(err).not.toHaveProperty("userType");
    expect(err.details.feature).toBe("support_chat");
    expect(err.details.userType).toBe("logged_in");
    expect(res.headers["x-ai-guard-request-id"]).toBeTruthy();
    await server.close();
  });

  it("auth denials return structured errors without 500", async () => {
    const server = app();
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat",
      payload,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
    await server.close();
  });

  it("forbidden API key returns 403 without touching the model", async () => {
    const server = buildServer({
      config,
      pool: mockPool() as never,
      litellm: {
        chat: async () => {
          throw new Error("model should not be called");
        },
      },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKeys: [{ name: "read-only", key: "ro", permissions: ["usage:read"] }],
    });
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer ro" },
      payload,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    await server.close();
  });

  it("routes hierarchical streaming through the unified pipeline (not a hard reject)", async () => {
    const server = buildServer({
      config,
      pool: mockPool() as never,
      litellm: {
        chat: async () => ({ content: "ok", model: "m", actualCostUsd: 0, raw: {} }),
        chatStream: async function* () {
          yield { delta: "x" };
          return { model: "m", actualCostUsd: 0, inputTokens: 1, outputTokens: 1, raw: {} };
        },
      },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKey: "secret",
      hierarchicalBudgets: true,
    });
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: {
        ...payload,
        stream: true,
        budgetNodeId: "team-support",
      },
    });
    // mockPool has no budget nodes — expect path load failure, not route-level reject.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
    expect(res.json().error.code).not.toBe("hierarchical_stream_not_supported");
    await server.close();
  });
});
