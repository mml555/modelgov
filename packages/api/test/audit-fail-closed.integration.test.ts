import { parseConfigObject } from "@modelgov/policy-engine";
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

describe.skipIf(!DATABASE_URL)("request audit fail-closed behavior (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await dropAuditFailureTrigger(pool);
    await pool.end();
  });
  beforeEach(async () => {
    await dropAuditFailureTrigger(pool);
    await pool.query("TRUNCATE budget_counters, request_logs, idempotency_keys");
  });

  function app(): FastifyInstance {
    return buildServer({
      config,
      pool,
      litellm: {
        chat: async () => ({
          content: "should not be returned without audit",
          model: "openai/gpt-4o-mini",
          actualCostUsd: 0.0002,
          inputTokens: 12,
          outputTokens: 8,
          raw: {},
        }),
      },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      allowUnauthenticated: true,
    });
  }

  it("does not return model output when request audit insert fails after settlement", async () => {
    await installAuditFailureTrigger(pool);
    const res = await app().inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        userId: "u1",
        userType: "logged_in",
        feature: "support_chat",
        messages: [{ role: "user", content: "hi" }],
      },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("audit_unavailable");
    expect(res.body).not.toContain("should not be returned without audit");
    expect(res.body).not.toContain("req_unknown");

    const used = await pool.query(
      "SELECT used_usd FROM budget_counters WHERE scope='user_daily' AND key='u1'",
    );
    expect(Number(used.rows[0].used_usd)).toBeCloseTo(0.0002, 6);
  });
});

async function installAuditFailureTrigger(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_request_log_insert()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'request audit unavailable';
    END;
    $$;
  `);
  await pool.query(`
    CREATE TRIGGER fail_request_log_insert
    BEFORE INSERT ON request_logs
    FOR EACH ROW
    EXECUTE FUNCTION fail_request_log_insert();
  `);
}

async function dropAuditFailureTrigger(pool: Pool): Promise<void> {
  await pool.query("DROP TRIGGER IF EXISTS fail_request_log_insert ON request_logs");
  await pool.query("DROP FUNCTION IF EXISTS fail_request_log_insert()");
}
