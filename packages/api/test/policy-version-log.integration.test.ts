import { parseConfigObject } from "@ai-guard/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";

const DATABASE_URL = process.env.DATABASE_URL;

const config = parseConfigObject({
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
    by_user_type: { logged_in: { daily_usd: 10, daily_requests: 100, models: ["cheap"] } },
  },
  features: { support_chat: { safety: "dev", model_class: "cheap", max_tokens: 50 } },
  model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
  safety: { preset: "dev" },
});

describe.skipIf(!DATABASE_URL)("config_hash / policy_version on request logs (integration)", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE request_logs, budget_counters, budget_reservation_leases");
  });

  function app(): FastifyInstance {
    return buildServer({
      config,
      pool,
      litellm: { chat: async () => ({ content: "ok", model: "openai/gpt-4o-mini", actualCostUsd: 0.001, inputTokens: 5, outputTokens: 2, raw: {} }) },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKeys: [{ name: "ops", key: "secret", permissions: ["chat:create", "requests:read"] }],
      policyMeta: { configHash: "hash-abc123", policyVersion: "v7" },
    });
  }

  it("stamps the active policy identity on the request log and the read API", async () => {
    const server = app();
    const chat = await server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: { userId: "u1", userType: "logged_in", feature: "support_chat", messages: [{ role: "user", content: "hi" }] },
    });
    expect(chat.statusCode).toBe(200);
    const requestId = chat.json().requestId as string;

    // Column is populated in the DB...
    const { rows } = await pool.query("SELECT config_hash, policy_version FROM request_logs WHERE feature = 'support_chat'");
    expect(rows[0].config_hash).toBe("hash-abc123");
    expect(rows[0].policy_version).toBe("v7");

    // ...and surfaced by the operator read API.
    const show = await server.inject({
      method: "GET",
      url: `/v1/requests/${requestId}`,
      headers: { authorization: "Bearer secret" },
    });
    expect(show.statusCode).toBe(200);
    expect(show.json().policy).toEqual({ configHash: "hash-abc123", policyVersion: "v7" });
  });
});
