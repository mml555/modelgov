import { parseConfigObject } from "@modelgov/policy-engine";
import { describe, expect, it } from "vitest";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";
import { mockPool } from "./mockPool";

const config = parseConfigObject({
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 100, hard_stop_at_percent: 100 },
    by_user_type: { logged_in: { daily_usd: 1, daily_requests: 10, models: ["cheap"] } },
  },
  features: { support_chat: { safety: "dev", model_class: "cheap", max_tokens: 100 } },
  model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
  safety: { preset: "dev" },
});

// A LiteLLM /health body with one down endpoint, to exercise parsing + status.
const litellmHealthBody = {
  healthy_endpoints: [{ model: "openai/gpt-4o" }, { model: "bedrock/anthropic.claude-3-opus-20240229-v1:0" }],
  unhealthy_endpoints: [{ model: "azure/gpt-4o", error: "401 Unauthorized" }],
};

function app(opts: { withLitellm?: boolean } = {}) {
  return buildServer({
    config,
    pool: mockPool() as never,
    litellm: { chat: async () => { throw new Error("unreached"); } },
    safety: new NoopGuard(),
    observability: new NoopObservability(),
    logger: false,
    // Two static keys with distinct permissions.
    apiKeys: [
      { name: "viewer", key: "viewer-key", permissions: ["usage:read"] },
      { name: "chatter", key: "chat-key", permissions: ["chat:create"] },
    ],
    ...(opts.withLitellm
      ? {
          health: {
            litellmBaseUrl: "http://litellm:4000",
            fetchImpl: (async () => new Response(JSON.stringify(litellmHealthBody), { status: 200 })) as typeof fetch,
          },
        }
      : {}),
  });
}

describe("GET /v1/admin/providers/health", () => {
  it("requires authentication", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/admin/providers/health" });
    expect(res.statusCode).toBe(401);
  });

  it("forbids a principal without usage:read", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/v1/admin/providers/health",
      headers: { authorization: "Bearer chat-key" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("returns per-model health for a usage:read principal", async () => {
    const res = await app({ withLitellm: true }).inject({
      method: "GET",
      url: "/v1/admin/providers/health",
      headers: { authorization: "Bearer viewer-key" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("degraded");
    expect(body.models).toContainEqual({ model: "azure/gpt-4o", provider: "azure", healthy: false, error: "401 Unauthorized" });
    expect(body.models).toContainEqual({ model: "bedrock/anthropic.claude-3-opus-20240229-v1:0", provider: "bedrock", healthy: true });
  });

  it("reports skipped when no LiteLLM proxy is configured", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/v1/admin/providers/health",
      headers: { authorization: "Bearer viewer-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("skipped");
  });
});
