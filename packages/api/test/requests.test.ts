import { parseConfigObject } from "@ai-guard/policy-engine";
import { describe, expect, it } from "vitest";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";
import { rowToRecord } from "../src/modules/requests/repo";
import { inferReasonCode } from "../src/modules/requests/reasonCode";

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

const sampleRow = {
  id: "42",
  created_at: new Date("2026-06-01T12:00:00Z"),
  project_id: "test",
  environment: "test",
  user_id: "user_1",
  user_type: "logged_in",
  feature: "support_chat",
  model_class: "cheap",
  requested_model_class: "standard",
  resolved_model: "openai/gpt-4o-mini",
  decision: "block",
  status: "failed",
  estimated_cost_usd: "0.002",
  actual_cost_usd: "0",
  input_tokens: null,
  output_tokens: null,
  pii_masked: false,
  injection_blocked: false,
  error: "model_class 'standard' is not permitted for user_type 'logged_in'",
  reason_code: "model_class_not_permitted",
  host_metadata: { app: "jewgo", eventDraftId: "draft_1" },
  config_hash: "abc123",
  policy_version: "file",
};

function poolWithRows() {
  return {
    query: async (sql: string, _params?: unknown[]) => {
      if (sql.includes("FROM request_logs WHERE id =")) {
        return { rows: [sampleRow], rowCount: 1 };
      }
      if (sql.includes("FROM request_logs") && sql.includes("ORDER BY")) {
        return { rows: [sampleRow], rowCount: 1 };
      }
      if (sql.includes("count(*)")) {
        return {
          rows: [{
            requests: "10",
            completed: "6",
            blocked: "3",
            degraded: "1",
            fallbacks: "0",
            safety_blocked: "1",
            actual_cost: "1.5",
            estimated_cost: "1.6",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("GROUP BY 1")) {
        if (sql.includes("reason_code")) {
          return { rows: [{ code: "daily_budget_exceeded", count: "2" }], rowCount: 1 };
        }
        if (sql.includes("resolved_model")) {
          return { rows: [{ model: "openai/gpt-4o-mini", count: "5" }], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 1 }),
      release: () => {},
    }),
  };
}

function app(apiKeys = [{ name: "ops", key: "secret", permissions: ["chat:create", "requests:read", "usage:read"] }]) {
  return buildServer({
    config,
    pool: poolWithRows() as never,
    litellm: { chat: async () => ({ content: "ok", model: "m", actualCostUsd: 0, raw: {} }) },
    safety: new NoopGuard(),
    observability: new NoopObservability(),
    logger: false,
    apiKeys,
  });
}

describe("request visibility", () => {
  it("maps db rows to operator-friendly records", () => {
    const record = rowToRecord(sampleRow);
    expect(record.id).toBe("req_42");
    expect(record.status).toBe("blocked");
    expect(record.reasonCode).toBe("model_class_not_permitted");
    expect(record.requestedModelClass).toBe("standard");
    expect(record.provider).toBe("openai");
    expect(record.metadata).toEqual({ app: "jewgo", eventDraftId: "draft_1" });
  });

  it("infers legacy reason codes from error text", () => {
    expect(inferReasonCode("daily request limit reached (5)", "block")).toBe(
      "daily_request_limit_reached",
    );
  });

  it("GET /v1/requests/:id requires requests:read", async () => {
    const server = app([{ name: "chat", key: "secret", permissions: ["chat:create"] }]);
    const denied = await server.inject({
      method: "GET",
      url: "/v1/requests/req_42",
      headers: { authorization: "Bearer secret" },
    });
    expect(denied.statusCode).toBe(403);
    await server.close();
  });

  it("GET /v1/requests/:id returns a record", async () => {
    const server = app();
    const res = await server.inject({
      method: "GET",
      url: "/v1/requests/req_42",
      headers: { authorization: "Bearer secret" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("req_42");
    expect(res.json().reasonCode).toBe("model_class_not_permitted");
    // provider must survive Fastify serialization (present in the response schema).
    expect(res.json().provider).toBe("openai");
    await server.close();
  });

  it("GET /v1/requests lists with filters", async () => {
    const server = app();
    const res = await server.inject({
      method: "GET",
      url: "/v1/requests?feature=support_chat&status=blocked",
      headers: { authorization: "Bearer secret" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    await server.close();
  });

  it("GET /v1/usage/summary returns aggregates", async () => {
    const server = app();
    const res = await server.inject({
      method: "GET",
      url: "/v1/usage/summary?since=24h",
      headers: { authorization: "Bearer secret" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().requests).toBe(10);
    expect(res.json().actualCostUsd).toBe(1.5);
    await server.close();
  });
});
