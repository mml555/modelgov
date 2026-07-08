import { parseConfigObject } from "@modelgov/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import { appendAudit } from "../src/modules/audit/repo";
import { createApiKey } from "../src/modules/keys/repo";
import { createDbKeyResolver } from "../src/modules/keys/resolver";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";

const DATABASE_URL = process.env.DATABASE_URL;
const TENANT_HEADER = "x-modelgov-tenant";

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

/**
 * Regression guard for the seventh-review HIGH: an unbound operator WITHOUT
 * tenant:switch must be confined to the default (untenanted) partition on the
 * control plane, exactly like the data plane — it must not be able to omit the
 * X-Modelgov-Tenant header and reach another tenant's keys, audit trail, or
 * emergency switch. Only a platform operator holding tenant:switch sees all.
 */
describe.skipIf(!DATABASE_URL)("control-plane tenant confinement (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE api_keys, admin_audit_log, system_flags");
  });

  function app(): FastifyInstance {
    return buildServer({
      config,
      pool,
      litellm: { chat: async () => ({ content: "ok", model: "m", actualCostUsd: 0, raw: {} }) },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      // keyResolver is what registers the /v1/admin/keys and /v1/admin/audit routes.
      keyResolver: createDbKeyResolver(pool, { cacheTtlMs: 10_000 }),
      apiKeys: [
        // Unbound key-admin WITHOUT tenant:switch — the OIDC-operator escape this guards against.
        { name: "keyadmin", key: "keyadmin-key", permissions: ["keys:admin", "audit:read"] },
        // Unbound operator that CAN pause (policy:write) but has no tenant:switch.
        { name: "pauser", key: "pauser-key", permissions: ["policy:write", "policy:read"] },
        // Platform operator — unbound AND holds tenant:switch (owner-like).
        {
          name: "platform",
          key: "platform-key",
          permissions: ["keys:admin", "audit:read", "policy:write", "policy:read", "tenant:switch"],
        },
      ],
    });
  }

  const auth = (key: string, tenant?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    if (tenant) headers[TENANT_HEADER] = tenant;
    return headers;
  };

  async function seedKey(name: string, tenantId?: string): Promise<string> {
    const { record } = await createApiKey(pool, { name, permissions: ["chat:create"], tenantId });
    return record.id;
  }

  describe("API keys", () => {
    it("confines list/get/rotate/revoke to the default partition without tenant:switch", async () => {
      const server = app();
      const acmeId = await seedKey("acme-svc", "acme");
      const defaultId = await seedKey("default-svc"); // untenanted → NULL

      // List: the confined key-admin sees ONLY the untenanted key, never acme's.
      const list = await server.inject({ method: "GET", url: "/v1/admin/keys", headers: auth("keyadmin-key") });
      expect(list.statusCode).toBe(200);
      const ids = (list.json().items as Array<{ id: string }>).map((k) => k.id);
      expect(ids).toContain(defaultId);
      expect(ids).not.toContain(acmeId);

      // Get / rotate / revoke another tenant's key → 404 (looks unknown, no secret leak).
      expect((await server.inject({ method: "GET", url: `/v1/admin/keys/${acmeId}`, headers: auth("keyadmin-key") })).statusCode).toBe(404);
      const rotate = await server.inject({ method: "POST", url: `/v1/admin/keys/${acmeId}/rotate`, headers: auth("keyadmin-key") });
      expect(rotate.statusCode).toBe(404);
      expect(rotate.json().secret).toBeUndefined();
      expect((await server.inject({ method: "POST", url: `/v1/admin/keys/${acmeId}/revoke`, headers: auth("keyadmin-key") })).statusCode).toBe(404);
    });

    it("lets a platform operator (tenant:switch) see and rotate any tenant's key", async () => {
      const server = app();
      const acmeId = await seedKey("acme-svc", "acme");
      await seedKey("default-svc");

      const list = await server.inject({ method: "GET", url: "/v1/admin/keys", headers: auth("platform-key") });
      expect((list.json().items as unknown[]).length).toBe(2);

      const rotate = await server.inject({ method: "POST", url: `/v1/admin/keys/${acmeId}/rotate`, headers: auth("platform-key") });
      expect(rotate.statusCode).toBe(200);
      expect(rotate.json().secret).toMatch(/^sk-modelgov-/);
    });

    it("forbids minting a key for another tenant without tenant:switch", async () => {
      const res = await app().inject({
        method: "POST",
        url: "/v1/admin/keys",
        headers: auth("keyadmin-key"),
        payload: { name: "cross", permissions: ["chat:create"], tenantId: "acme" },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("emergency pause", () => {
    it("confines an operator without tenant:switch to its own partition switch", async () => {
      const server = app();
      const res = await server.inject({ method: "POST", url: "/v1/admin/emergency/pause", headers: auth("pauser-key"), payload: {} });
      expect(res.statusCode).toBe(200);

      // The PLATFORM-wide switch must NOT be set; only the default-partition one.
      const flags = await pool.query<{ key: string }>("SELECT key FROM system_flags");
      const keys = flags.rows.map((r) => r.key);
      expect(keys).not.toContain("ai_requests_paused"); // platform-wide
      expect(keys).toContain("ai_requests_paused:"); // default-partition switch
    });

    it("lets a platform operator set the platform-wide switch", async () => {
      const server = app();
      await server.inject({ method: "POST", url: "/v1/admin/emergency/pause", headers: auth("platform-key"), payload: {} });
      const flags = await pool.query<{ key: string }>("SELECT key FROM system_flags");
      expect(flags.rows.map((r) => r.key)).toContain("ai_requests_paused");
    });
  });

  describe("audit trail", () => {
    beforeEach(async () => {
      // Two audit rows via the real append path (computes hashes + created_at):
      // one in tenant acme, one in the default ('') partition.
      await appendAudit(pool, { actor: "a", action: "x", target: "t", tenantId: "acme" });
      await appendAudit(pool, { actor: "a", action: "y", target: "t", tenantId: "" });
    });

    it("confines audit reads to the default partition without tenant:switch", async () => {
      const res = await app().inject({ method: "GET", url: "/v1/admin/audit", headers: auth("keyadmin-key") });
      expect(res.statusCode).toBe(200);
      const actions = (res.json().items as Array<{ action: string; tenantId: string }>);
      expect(actions.every((a) => a.tenantId === "")).toBe(true);
      expect(actions.some((a) => a.action === "x")).toBe(false); // the acme row is hidden
    });

    it("lets a platform operator read every tenant's audit rows", async () => {
      const res = await app().inject({ method: "GET", url: "/v1/admin/audit", headers: auth("platform-key") });
      expect((res.json().items as unknown[]).length).toBe(2);
    });

    it("restricts chain verification to platform operators", async () => {
      expect((await app().inject({ method: "GET", url: "/v1/admin/audit/verify", headers: auth("keyadmin-key") })).statusCode).toBe(403);
      expect((await app().inject({ method: "GET", url: "/v1/admin/audit/verify", headers: auth("platform-key") })).statusCode).toBe(200);
    });
  });

  describe("tenant enumeration", () => {
    it("does not enumerate tenants for an unbound operator without tenant:switch", async () => {
      await seedKey("acme-svc", "acme");
      const res = await app().inject({ method: "GET", url: "/v1/admin/tenants", headers: auth("keyadmin-key") });
      expect(res.statusCode).toBe(200);
      expect(res.json().tenants).toEqual([]);
    });
  });
});
