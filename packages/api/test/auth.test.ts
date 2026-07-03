import { parseConfigObject } from "@modelgov/policy-engine";
import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/services/litellm";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard, SafetyServiceError, type SafetyGuard } from "../src/services/safety";
import { buildServer } from "../src/server";
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
  model_classes: {
    cheap: { primary: "openai/gpt-4o-mini" },
  },
  safety: { preset: "dev" },
});

function app() {
  const pool = mockPool();

  return buildServer({
    config,
    pool: pool as never,
    litellm: {
      chat: async () => {
        throw new Error("litellm should not be reached");
      },
    },
    safety: new NoopGuard(),
    observability: new NoopObservability(),
    logger: false,
    apiKey: "secret",
  });
}

function appWith(overrides: Partial<Parameters<typeof buildServer>[0]>) {
  return buildServer({
    ...appDeps(),
    ...overrides,
  });
}

function appDeps(): Parameters<typeof buildServer>[0] {
  const pool = mockPool();

  return {
    config,
    pool: pool as never,
    litellm: {
      chat: async () => {
        throw new Error("litellm should not be reached");
      },
    },
    safety: new NoopGuard(),
    observability: new NoopObservability(),
    logger: false,
    apiKey: "secret",
  };
}

const validChatPayload = {
  userId: "u1",
  userType: "logged_in",
  feature: "support_chat",
  messages: [{ role: "user", content: "hi" }],
};

describe("API auth", () => {
  it("allows health checks without a bearer token", async () => {
    const res = await app().inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("allows readiness checks without a bearer token", async () => {
    const res = await app().inject({ method: "GET", url: "/ready" });
    expect([200, 503]).toContain(res.statusCode);
  });

  it("allows health checks with query strings without a bearer token", async () => {
    const res = await app().inject({ method: "GET", url: "/health?ready=1" });
    expect(res.statusCode).toBe(200);
  });

  it("rejects chat requests without a bearer token", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/v1/chat",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("rejects chat requests with the wrong bearer token", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer wrong" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("lets authenticated requests reach route validation", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("surfaces which field failed validation (not a bare 400)", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      // valid except the missing `feature` — the detail must name it
      payload: { userId: "u1", userType: "logged_in", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
    expect(String(res.json().error.details.detail ?? "")).toContain("feature");
  });

  it("rejects a user id outside the API key scope", async () => {
    const res = await appWith({
      apiKey: undefined,
      apiKeys: [
        {
          name: "limited",
          key: "secret",
          allowedUserIds: ["user-a"],
          permissions: ["chat:create"],
        },
      ],
    }).inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: { ...validChatPayload, userId: "user-b" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("user_forbidden");
  });

  it("rejects a user type outside the API key scope", async () => {
    const res = await appWith({
      apiKey: undefined,
      apiKeys: [
        {
          name: "limited",
          key: "secret",
          allowedUserTypes: ["anonymous"],
          permissions: ["chat:create"],
        },
      ],
    }).inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: validChatPayload,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("user_type_forbidden");
  });

  it("rejects project overrides outside the API key scope", async () => {
    const res = await appWith({
      apiKey: undefined,
      apiKeys: [
        {
          name: "project-a",
          key: "secret",
          projectId: "project-a",
          permissions: ["chat:create"],
        },
      ],
    }).inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: { ...validChatPayload, projectId: "project-b" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("project_mismatch");
  });

  it("normalizes oversized request IDs before error serialization", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        authorization: "Bearer secret",
        "x-request-id": "x".repeat(200),
      },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.requestId).toHaveLength(36);
  });

  it("does not leak provider internals in API errors", async () => {
    const res = await appWith({
      litellm: {
        chat: async () => {
          throw new ProviderError("provider stack trace secret", 503);
        },
      },
    }).inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: validChatPayload,
    });

    const error = res.json().error;
    expect(res.statusCode).toBe(502);
    expect(error.code).toBe("provider_unavailable");
    expect(error.message).toBe("Provider unavailable");
    expect(JSON.stringify(error)).not.toContain("provider stack trace secret");
  });

  it("does not leak safety backend internals in API errors", async () => {
    const failingSafety: SafetyGuard = {
      async inspectInput() {
        throw new SafetyServiceError("presidio internal host detail");
      },
      async inspectOutput() {
        throw new SafetyServiceError("presidio internal host detail");
      },
    };

    const res = await appWith({ safety: failingSafety }).inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: validChatPayload,
    });

    const error = res.json().error;
    expect(res.statusCode).toBe(503);
    expect(error.code).toBe("safety_unavailable");
    expect(error.message).toBe("Safety service unavailable");
    expect(JSON.stringify(error)).not.toContain("presidio internal host detail");
  });
});
