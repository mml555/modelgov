import { parseConfigObject } from "@modelgov/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import { appendAudit, listAudit, verifyAuditChain } from "../src/modules/audit/repo";
import { createDbKeyResolver } from "../src/modules/keys/resolver";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";

const DATABASE_URL = process.env.DATABASE_URL;

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

describe.skipIf(!DATABASE_URL)("admin audit log (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE admin_audit_log, api_keys");
  });

  describe("hash chain", () => {
    it("links rows and verifies intact", async () => {
      const a = await appendAudit(pool, { actor: "op1", action: "key.create", target: "k1" });
      const b = await appendAudit(pool, { actor: "op1", action: "key.revoke", target: "k1" });
      expect(a.prevHash).toBe("genesis");
      expect(b.prevHash).toBe(a.rowHash);
      const v = await verifyAuditChain(pool);
      expect(v).toEqual({ ok: true, rows: 2 });
    });

    it("detects tampering with a historical row", async () => {
      await appendAudit(pool, { actor: "op1", action: "key.create", target: "k1" });
      const b = await appendAudit(pool, { actor: "op1", action: "key.revoke", target: "k1" });
      await appendAudit(pool, { actor: "op1", action: "key.create", target: "k2" });

      // Tamper: rewrite the middle row's actor without fixing the chain.
      await pool.query("UPDATE admin_audit_log SET actor = 'attacker' WHERE id = $1", [b.id]);

      const v = await verifyAuditChain(pool);
      expect(v.ok).toBe(false);
      expect(v.brokenAtId).toBe(b.id);
    });

    it("detects a deleted row", async () => {
      await appendAudit(pool, { actor: "op1", action: "a" });
      const b = await appendAudit(pool, { actor: "op1", action: "b" });
      await appendAudit(pool, { actor: "op1", action: "c" });
      await pool.query("DELETE FROM admin_audit_log WHERE id = $1", [b.id]);
      const v = await verifyAuditChain(pool);
      expect(v.ok).toBe(false);
    });

    it("filters by action", async () => {
      await appendAudit(pool, { actor: "op1", action: "key.create", target: "k1" });
      await appendAudit(pool, { actor: "op1", action: "key.revoke", target: "k1" });
      const revokes = await listAudit(pool, { action: "key.revoke" });
      expect(revokes).toHaveLength(1);
      expect(revokes[0]?.action).toBe("key.revoke");
    });
  });

  describe("wired to key mutations + read API", () => {
    function app(): FastifyInstance {
      return buildServer({
        config,
        pool,
        litellm: { chat: async () => ({ content: "ok", model: "m", actualCostUsd: 0, raw: {} }) },
        safety: new NoopGuard(),
        observability: new NoopObservability(),
        logger: false,
        // Platform root operator: manages keys across the deployment and verifies
        // the global (all-tenant) audit chain, so it holds tenant:switch.
        apiKeys: [
          { name: "admin", key: "admin-secret", permissions: ["keys:admin", "audit:read", "tenant:switch"] },
        ],
        keyResolver: createDbKeyResolver(pool, { cacheTtlMs: 1000 }),
      });
    }
    const admin = { authorization: "Bearer admin-secret" };

    it("records key create + revoke and exposes them via the audit API", async () => {
      const server = app();
      const created = await server.inject({
        method: "POST",
        url: "/v1/admin/keys",
        headers: admin,
        payload: { name: "svc", permissions: ["chat:create"] },
      });
      const id = created.json().id as string;
      await server.inject({ method: "POST", url: `/v1/admin/keys/${id}/revoke`, headers: admin });

      const audit = await server.inject({ method: "GET", url: "/v1/admin/audit", headers: admin });
      expect(audit.statusCode).toBe(200);
      const actions = audit.json().items.map((i: { action: string }) => i.action);
      expect(actions).toContain("key.create");
      expect(actions).toContain("key.revoke");

      const verify = await server.inject({ method: "GET", url: "/v1/admin/audit/verify", headers: admin });
      expect(verify.json().ok).toBe(true);
    });

    it("denies the audit API without audit:read", async () => {
      const server = app();
      const created = await server.inject({
        method: "POST",
        url: "/v1/admin/keys",
        headers: admin,
        payload: { name: "chat-only", permissions: ["chat:create"] },
      });
      const secret = created.json().secret as string;
      const res = await server.inject({
        method: "GET",
        url: "/v1/admin/audit",
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
