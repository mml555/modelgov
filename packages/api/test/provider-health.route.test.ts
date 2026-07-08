import { parseConfigObject } from "@modelgov/policy-engine";
import { describe, expect, it, vi } from "vitest";
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

  it("serves a cached result within the TTL (no per-poll fan-out to LiteLLM)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(litellmHealthBody), { status: 200 }));
    const server = buildServer({
      config,
      pool: mockPool() as never,
      litellm: { chat: async () => { throw new Error("unreached"); } },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKeys: [{ name: "viewer", key: "viewer-key", permissions: ["usage:read"] }],
      health: { litellmBaseUrl: "http://litellm:4000", fetchImpl: fetchImpl as typeof fetch },
    });
    const call = () => server.inject({ method: "GET", url: "/v1/admin/providers/health", headers: { authorization: "Bearer viewer-key" } });
    const first = await call();
    const second = await call();
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    // Two requests, but LiteLLM was hit only once (second served from cache).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the TTL expires", async () => {
    // Fake only Date so the route's TTL check advances, without touching the
    // real timers Fastify's inject relies on.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = new Date("2026-01-01T00:00:00Z").getTime();
      vi.setSystemTime(t0);
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(litellmHealthBody), { status: 200 }));
      const server = buildServer({
        config,
        pool: mockPool() as never,
        litellm: { chat: async () => { throw new Error("unreached"); } },
        safety: new NoopGuard(),
        observability: new NoopObservability(),
        logger: false,
        apiKeys: [{ name: "viewer", key: "viewer-key", permissions: ["usage:read"] }],
        health: { litellmBaseUrl: "http://litellm:4000", fetchImpl: fetchImpl as typeof fetch },
      });
      const call = () => server.inject({ method: "GET", url: "/v1/admin/providers/health", headers: { authorization: "Bearer viewer-key" } });
      await call();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      vi.setSystemTime(t0 + 16_000); // past the 15s TTL
      await call();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces concurrent cache misses onto a single upstream call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchImpl = vi.fn(async () => {
      await gate; // hold all callers in the fetch until released
      return new Response(JSON.stringify(litellmHealthBody), { status: 200 });
    });
    const server = buildServer({
      config,
      pool: mockPool() as never,
      litellm: { chat: async () => { throw new Error("unreached"); } },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKeys: [{ name: "viewer", key: "viewer-key", permissions: ["usage:read"] }],
      health: { litellmBaseUrl: "http://litellm:4000", fetchImpl: fetchImpl as typeof fetch },
    });
    const call = () => server.inject({ method: "GET", url: "/v1/admin/providers/health", headers: { authorization: "Bearer viewer-key" } });
    const inflight = [call(), call(), call()];
    // Let all three handlers reach `await providerHealthInFlight` before resolving.
    await new Promise((r) => setImmediate(r));
    release();
    const results = await Promise.all(inflight);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    // Three concurrent misses, one upstream call.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
