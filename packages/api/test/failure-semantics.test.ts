import { describe, expect, it } from "vitest";
import { parseConfigObject } from "@ai-guard/policy-engine";
import { ProviderError } from "../src/services/litellm";
import { NoopObservability } from "../src/services/observability";
import {
  NoopGuard,
  SafetyServiceError,
  type SafetyGuard,
} from "../src/services/safety";
import { checkReady } from "../src/modules/health/service";
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
    support_chat: { safety: "strict", model_class: "cheap", max_tokens: 100 },
  },
  model_classes: {
    cheap: { primary: "openai/gpt-4o-mini", fallback: "anthropic/claude-haiku" },
    standard: { primary: "anthropic/claude-sonnet", fallback: "openai/gpt-4o" },
  },
  safety: { preset: "strict", protect: { pii: "block", prompt_injection: "block" } },
});

const payload = {
  userId: "u1",
  userType: "logged_in",
  feature: "support_chat",
  messages: [{ role: "user", content: "hi" }],
};

function poolOk() {
  return mockPool(1);
}

function app(overrides: Partial<BuildServerOptions> = {}) {
  return buildServer({
    config,
    pool: poolOk() as never,
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
    ...overrides,
  });
}

describe("dependency failure semantics", () => {
  it("readiness fails closed when Postgres is down", async () => {
    const ready = await checkReady({
      pool: {
        query: async () => {
          throw new Error("db down");
        },
      } as never,
    });
    expect(ready.status).toBe("not_ready");
    expect(ready.checks.database).toBe("fail");
  });

  it("liveness stays ok when Postgres is down", async () => {
    const server = app({
      pool: {
        query: async () => {
          throw new Error("db down");
        },
        connect: async () => {
          throw new Error("db down");
        },
      } as never,
    });
    const health = await server.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    await server.close();
  });

  it("LiteLLM down with fallback configured → 200 fallback", async () => {
    let call = 0;
    const server = app({
      litellm: {
        chat: async ({ model }) => {
          call++;
          if (model === "openai/gpt-4o-mini") {
            throw new ProviderError("primary down");
          }
          return { content: "fallback ok", model, actualCostUsd: 0.0001, raw: {} };
        },
      },
    });
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision).toBe("fallback");
    expect(call).toBe(2);
    await server.close();
  });

  it("LiteLLM down without fallback path → 502 provider_unavailable", async () => {
    const server = buildServer({
      config: parseConfigObject({
        project: { name: "t", environment: "t" },
        budgets: {
          global: { monthly_usd: 0 },
          by_user_type: {
            logged_in: { daily_usd: 1, daily_requests: 10, models: ["cheap"] },
          },
        },
        features: { support_chat: { model_class: "cheap", max_tokens: 100 } },
        model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
        safety: { preset: "dev" },
      }),
      pool: poolOk() as never,
      litellm: {
        chat: async () => {
          throw new ProviderError("down");
        },
      },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKey: "secret",
    });
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("provider_unavailable");
    await server.close();
  });

  it("Presidio/safety backend down with strict safety → 503 safety_unavailable", async () => {
    const failingSafety: SafetyGuard = {
      inspectInput: async () => {
        throw new SafetyServiceError("presidio down");
      },
      inspectOutput: async (content) => ({
        action: "allow" as const,
        content,
        piiMasked: false,
        injectionBlocked: false,
        findings: [],
        safetyCostUsd: 0,
      }),
    };
    const server = app({ safety: failingSafety });
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("safety_unavailable");
    await server.close();
  });

  it("observability failures do not block chat (covered in observability.test.ts)", async () => {
    const server = app();
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload,
    });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it("policy_blocked returns stable error contract fields", async () => {
    const server = app();
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: {
        ...payload,
        modelClass: "standard",
      },
    });
    expect(res.statusCode).toBe(403);
    const err = res.json().error;
    expect(err.code).toBe("policy_blocked");
    expect(err.details.decision).toBe("block");
    expect(err.details.feature).toBe("support_chat");
    expect(err.details.userType).toBe("logged_in");
    expect(err.details.reasonCode).toBe("model_class_not_permitted");
    expect(err.details.budgetRemaining).toBeDefined();
    expect(err.details.auditRequestId).toBe("req_1");
    expect(res.headers["x-ai-guard-request-id"]).toBe("req_1");
    expect(err.requestId).toEqual(expect.any(String));
    await server.close();
  });

  it("success returns audit requestId for host app correlation", async () => {
    const server = app();
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: {
        ...payload,
        metadata: { app: "jewgo", eventDraftId: "draft_1" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requestId).toBe("req_1");
    expect(res.headers["x-ai-guard-request-id"]).toBe("req_1");
    await server.close();
  });
});
