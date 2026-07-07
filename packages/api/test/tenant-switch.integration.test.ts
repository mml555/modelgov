import { parseConfigObject } from "@modelgov/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
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

async function seedRequest(pool: Pool, tenantId: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO request_logs (tenant_id, project_id, user_id, user_type, feature, decision, status)
     VALUES ($1, 'test', 'u', 'logged_in', 'support_chat', 'allow', 'ok')`,
    [tenantId],
  );
}

describe.skipIf(!DATABASE_URL)("platform tenant switching (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE request_logs RESTART IDENTITY");
    await seedRequest(pool, "acme");
    await seedRequest(pool, "acme");
    await seedRequest(pool, "globex");
    await seedRequest(pool, null); // untenanted / default partition
  });

  function app(): FastifyInstance {
    return buildServer({
      config,
      pool,
      litellm: { chat: async () => ({ content: "ok", model: "m", actualCostUsd: 0, raw: {} }) },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKeys: [
        // Platform (unbound) operator — may switch tenants (holds tenant:switch).
        { name: "platform", key: "platform-key", permissions: ["usage:read", "requests:read", "tenant:switch"] },
        // Unbound read-only operator WITHOUT tenant:switch — must not be able to
        // scope to another tenant (the OIDC-viewer escape this guards against).
        { name: "reader", key: "reader-key", permissions: ["usage:read", "requests:read"] },
        // Tenant-bound operator — locked to globex.
        { name: "bound", key: "bound-key", permissions: ["usage:read", "requests:read"], tenantId: "globex" },
        // Chat-only key — no read perms.
        { name: "chat", key: "chat-key", permissions: ["chat:create"] },
      ],
    });
  }

  const summaryRequests = async (server: FastifyInstance, key: string, tenant?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    if (tenant) headers[TENANT_HEADER] = tenant;
    const res = await server.inject({ method: "GET", url: "/v1/usage/summary?since=24h", headers });
    expect(res.statusCode).toBe(200);
    return res.json().requests as number;
  };

  it("platform operator with no tenant sees only the untenanted partition", async () => {
    expect(await summaryRequests(app(), "platform-key")).toBe(1);
  });

  it("platform operator scopes to a tenant via X-Modelgov-Tenant", async () => {
    const server = app();
    expect(await summaryRequests(server, "platform-key", "acme")).toBe(2);
    expect(await summaryRequests(server, "platform-key", "globex")).toBe(1);
  });

  it("a tenant-bound key ignores the override header (locked to its tenant)", async () => {
    // bound to globex; attempts to view acme — must still see only globex (1).
    expect(await summaryRequests(app(), "bound-key", "acme")).toBe(1);
  });

  it("an unbound key WITHOUT tenant:switch is forbidden from targeting a tenant", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/v1/usage/summary?since=24h",
      headers: { authorization: "Bearer reader-key", [TENANT_HEADER]: "acme" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("an unbound key without tenant:switch still sees its own (untenanted) partition", async () => {
    // No override header → confined to the default partition, not blocked.
    expect(await summaryRequests(app(), "reader-key")).toBe(1);
  });

  it("GET /v1/admin/tenants lists all tenants for a platform operator", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/v1/admin/tenants",
      headers: { authorization: "Bearer platform-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tenants).toEqual(["acme", "globex"]);
  });

  it("GET /v1/admin/tenants returns only its own tenant for a bound key", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/v1/admin/tenants",
      headers: { authorization: "Bearer bound-key", [TENANT_HEADER]: "acme" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tenants).toEqual(["globex"]);
  });

  it("GET /v1/admin/tenants is forbidden without a read permission", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/v1/admin/tenants",
      headers: { authorization: "Bearer chat-key" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("whoami reflects the override for a platform operator, and locks a bound key", async () => {
    const server = app();
    const platform = await server.inject({
      method: "GET",
      url: "/v1/admin/whoami",
      headers: { authorization: "Bearer platform-key", [TENANT_HEADER]: "acme" },
    });
    expect(platform.json()).toMatchObject({ tenantId: "acme", tenantBound: false });

    const bound = await server.inject({
      method: "GET",
      url: "/v1/admin/whoami",
      headers: { authorization: "Bearer bound-key", [TENANT_HEADER]: "acme" },
    });
    expect(bound.json()).toMatchObject({ tenantId: "globex", tenantBound: true });
  });
});
