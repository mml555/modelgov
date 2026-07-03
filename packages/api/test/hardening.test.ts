import { parseConfigObject } from "@modelgov/policy-engine";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer, type BuildServerOptions } from "../src/server";
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
    support_chat: { safety: "dev", model_class: "cheap", max_tokens: 100 },
  },
  model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
  safety: { preset: "dev" },
});

function fakePool() {
  return {
    ...mockPool(),
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  };
}

function app(overrides: Partial<BuildServerOptions> = {}): FastifyInstance {
  return buildServer({
    config,
    pool: fakePool() as never,
    litellm: {
      chat: async () => ({ content: "ok", model: "m", actualCostUsd: 0, raw: {} }),
    },
    safety: new NoopGuard(),
    observability: new NoopObservability(),
    logger: false,
    apiKey: "secret",
    metrics: true,
    corsAllowOrigins: ["https://app.example.com"],
    ...overrides,
  });
}

const validPayload = {
  userId: "u1",
  userType: "logged_in",
  feature: "support_chat",
  messages: [{ role: "user", content: "hi" }],
};

describe("production hardening", () => {
  it("sets security headers on every response (H9)", async () => {
    const res = await app().inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });

  it("emits HSTS only when production mode is enabled", async () => {
    const res = await app({ production: true }).inject({ method: "GET", url: "/health" });
    expect(String(res.headers["strict-transport-security"])).toContain("max-age=");
  });

  it("liveness /health never touches the database (H6)", async () => {
    const throwingPool = {
      query: async () => {
        throw new Error("db down");
      },
      connect: async () => {
        throw new Error("db down");
      },
    };
    const server = buildServer({
      config,
      pool: throwingPool as never,
      litellm: { chat: async () => ({ content: "ok", model: "m", actualCostUsd: 0, raw: {} }) },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKey: "secret",
    });
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("exposes Prometheus metrics without auth when METRICS_AUTH_TOKEN is unset (H4)", async () => {
    const server = app();
    await server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: validPayload,
    });
    const res = await server.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("http_requests_total");
    expect(res.body).toContain("pg_pool_connections_total");
  });

  it("requires METRICS_AUTH_TOKEN when configured", async () => {
    const server = app({ metricsAuthToken: "metrics-secret" });
    const denied = await server.inject({ method: "GET", url: "/metrics" });
    expect(denied.statusCode).toBe(401);
    const ok = await server.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer metrics-secret" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("answers CORS preflight for an allowed origin (H9)", async () => {
    const res = await app().inject({
      method: "OPTIONS",
      url: "/v1/chat",
      headers: { origin: "https://app.example.com" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });

  it("does not emit CORS headers for a disallowed origin (H9)", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects requests exceeding the message-count cap (M1)", async () => {
    const messages = Array.from({ length: 65 }, () => ({ role: "user", content: "x" }));
    const res = await app().inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: { ...validPayload, messages },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rate-limits by API key hash when configured", async () => {
    const server = app({
      rateLimit: { max: 2, windowMs: 60_000, skipOnError: false },
    });
    await server.ready();
    const headers = { authorization: "Bearer secret" };
    const explainPayload = {
      userId: "u1",
      userType: "logged_in",
      feature: "support_chat",
    };
    expect(
      (await server.inject({ method: "POST", url: "/v1/explain", headers, payload: explainPayload }))
        .statusCode,
    ).toBe(200);
    expect(
      (await server.inject({ method: "POST", url: "/v1/explain", headers, payload: explainPayload }))
        .statusCode,
    ).toBe(200);
    const limited = await server.inject({
      method: "POST",
      url: "/v1/explain",
      headers,
      payload: explainPayload,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limit_exceeded");
    await server.close();
  });
});
