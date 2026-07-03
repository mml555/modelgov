import { parseConfigObject } from "@modelgov/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import { eraseUserData } from "../src/modules/governance/repo";
import { cleanupOldRequestLogsForFeature } from "../src/modules/usage/auditLogRepo";
import { createDbKeyResolver } from "../src/modules/keys/resolver";
import { verifyAuditChain } from "../src/modules/audit/repo";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";

const DATABASE_URL = process.env.DATABASE_URL;

async function insertLog(
  pool: Pool,
  opts: { userId: string; feature?: string; createdAt?: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO request_logs (created_at, user_id, feature, decision, status)
     VALUES (COALESCE($1::timestamptz, now()), $2, $3, 'allow', 'ok')`,
    [opts.createdAt ?? null, opts.userId, opts.feature ?? "support_chat"],
  );
}

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

describe.skipIf(!DATABASE_URL)("data governance (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE request_logs, idempotency_keys, admin_audit_log, api_keys");
  });

  describe("erasure", () => {
    it("erases only the target user's request logs and idempotency keys", async () => {
      await insertLog(pool, { userId: "alice" });
      await insertLog(pool, { userId: "alice" });
      await insertLog(pool, { userId: "bob" });
      await pool.query(
        `INSERT INTO idempotency_keys (key, user_id, request_hash, status) VALUES
           ('k1', 'alice', 'h', 'completed'), ('k2', 'bob', 'h', 'completed')`,
      );

      const result = await eraseUserData(pool, { userId: "alice" });
      expect(result).toEqual({ userId: "alice", requestLogs: 2, idempotencyKeys: 1, reservationLeases: 0 });

      const remaining = await pool.query("SELECT user_id FROM request_logs");
      expect(remaining.rows.every((r) => r.user_id === "bob")).toBe(true);
      const ik = await pool.query("SELECT user_id FROM idempotency_keys");
      expect(ik.rows.map((r) => r.user_id)).toEqual(["bob"]);
    });
  });

  describe("per-feature retention", () => {
    it("prunes only the named feature's rows older than its window", async () => {
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      await insertLog(pool, { userId: "u", feature: "hr_chat", createdAt: old });
      await insertLog(pool, { userId: "u", feature: "hr_chat" }); // recent
      await insertLog(pool, { userId: "u", feature: "support_chat", createdAt: old }); // other feature, untouched

      const removed = await cleanupOldRequestLogsForFeature(pool, "hr_chat", 7 * 24 * 60 * 60 * 1000);
      expect(removed).toBe(1);

      const rows = await pool.query("SELECT feature FROM request_logs ORDER BY feature");
      expect(rows.rows.map((r) => r.feature)).toEqual(["hr_chat", "support_chat"]);
    });
  });

  describe("erasure endpoint", () => {
    function app(): FastifyInstance {
      return buildServer({
        config,
        pool,
        litellm: { chat: async () => ({ content: "ok", model: "m", actualCostUsd: 0, raw: {} }) },
        safety: new NoopGuard(),
        observability: new NoopObservability(),
        logger: false,
        apiKeys: [
          { name: "dpo", key: "dpo-secret", permissions: ["data:erase", "audit:read"] },
          { name: "chat", key: "chat-secret", permissions: ["chat:create"] },
        ],
        keyResolver: createDbKeyResolver(pool, { cacheTtlMs: 1000 }),
      });
    }

    it("erases via the endpoint and writes an audit record", async () => {
      await insertLog(pool, { userId: "carol" });
      const server = app();
      const res = await server.inject({
        method: "POST",
        url: "/v1/admin/erasure",
        headers: { authorization: "Bearer dpo-secret" },
        payload: { userId: "carol" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().erased.requestLogs).toBe(1);

      const audit = await server.inject({
        method: "GET",
        url: "/v1/admin/audit?action=data.erasure",
        headers: { authorization: "Bearer dpo-secret" },
      });
      expect(audit.json().items[0].target).toBe("carol");
      expect((await verifyAuditChain(pool)).ok).toBe(true);
    });

    it("denies erasure without data:erase", async () => {
      const res = await app().inject({
        method: "POST",
        url: "/v1/admin/erasure",
        headers: { authorization: "Bearer chat-secret" },
        payload: { userId: "carol" },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("tenant-scoped erasure", () => {
    it("erases only rows for the given tenant partition", async () => {
      await pool.query(
        `INSERT INTO request_logs (tenant_id, user_id, feature, decision, status)
         VALUES ('tenant-a', 'shared-user', 'support_chat', 'allow', 'ok')`,
      );
      await pool.query(
        `INSERT INTO request_logs (tenant_id, user_id, feature, decision, status)
         VALUES ('tenant-b', 'shared-user', 'support_chat', 'allow', 'ok')`,
      );
      await pool.query(
        `INSERT INTO idempotency_keys (key, user_id, request_hash, status, tenant_id)
         VALUES ('k-a', 'shared-user', 'h', 'completed', 'tenant-a'),
                ('k-b', 'shared-user', 'h', 'completed', 'tenant-b')`,
      );

      const result = await eraseUserData(pool, { userId: "shared-user", tenantId: "tenant-a" });
      expect(result).toEqual({
        userId: "shared-user",
        tenantId: "tenant-a",
        requestLogs: 1,
        idempotencyKeys: 1,
        reservationLeases: 0,
      });

      const logs = await pool.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM request_logs WHERE user_id = $1",
        ["shared-user"],
      );
      expect(logs.rows).toEqual([{ tenant_id: "tenant-b" }]);

      const keys = await pool.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM idempotency_keys WHERE user_id = $1",
        ["shared-user"],
      );
      expect(keys.rows).toEqual([{ tenant_id: "tenant-b" }]);
    });

    it("scopes erasure via the endpoint to the caller's tenant", async () => {
      await pool.query(
        `INSERT INTO request_logs (tenant_id, user_id, feature, decision, status)
         VALUES ('tenant-a', 'eve', 'support_chat', 'allow', 'ok'),
                ('tenant-b', 'eve', 'support_chat', 'allow', 'ok')`,
      );
      const server = buildServer({
        config,
        pool,
        litellm: { chat: async () => ({ content: "ok", model: "m", actualCostUsd: 0, raw: {} }) },
        safety: new NoopGuard(),
        observability: new NoopObservability(),
        logger: false,
        apiKeys: [
          {
            name: "tenant-a-dpo",
            key: "dpo-a",
            permissions: ["data:erase"],
            tenantId: "tenant-a",
          },
        ],
        keyResolver: createDbKeyResolver(pool, { cacheTtlMs: 1000 }),
      });
      const res = await server.inject({
        method: "POST",
        url: "/v1/admin/erasure",
        headers: { authorization: "Bearer dpo-a" },
        payload: { userId: "eve" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().erased.requestLogs).toBe(1);

      const remaining = await pool.query("SELECT tenant_id FROM request_logs WHERE user_id = $1", ["eve"]);
      expect(remaining.rows).toEqual([{ tenant_id: "tenant-b" }]);
    });
  });
});
