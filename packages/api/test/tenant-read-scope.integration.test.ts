import { parseConfigObject } from "@ai-guard/policy-engine";
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
    by_user_type: { logged_in: { daily_usd: 1, daily_requests: 10, models: ["cheap"] } },
  },
  features: { support_chat: { safety: "dev", model_class: "cheap", max_tokens: 100 } },
  model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
  safety: { preset: "dev" },
});

describe.skipIf(!DATABASE_URL)("tenant-scoped request reads (integration)", () => {
  let pool: Pool;
  let tenantBId: number;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE request_logs");
    await pool.query(
      `INSERT INTO request_logs (
        tenant_id, project_id, user_id, user_type, feature, decision, status
      ) VALUES ('tenant-a', 'test', 'u1', 'logged_in', 'support_chat', 'allow', 'ok')`,
    );
    const b = await pool.query<{ id: string }>(
      `INSERT INTO request_logs (
        tenant_id, project_id, user_id, user_type, feature, decision, status
      ) VALUES ('tenant-b', 'test', 'u2', 'logged_in', 'support_chat', 'allow', 'ok')
      RETURNING id`,
    );
    tenantBId = Number(b.rows[0]!.id);
  });

  function app(tenantId: string) {
    return buildServer({
      config,
      pool,
      litellm: { chat: async () => ({ content: "ok", model: "m", actualCostUsd: 0, raw: {} }) },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKeys: [
        {
          name: `${tenantId}-reader`,
          key: `${tenantId}-key`,
          permissions: ["requests:read"],
          tenantId,
        },
      ],
    });
  }

  it("lists only rows for the caller's tenant", async () => {
    const res = await app("tenant-a").inject({
      method: "GET",
      url: "/v1/requests",
      headers: { authorization: "Bearer tenant-a-key" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string; userId?: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.userId).toBe("u1");
  });

  it("returns 404 for a cross-tenant request id", async () => {
    const res = await app("tenant-a").inject({
      method: "GET",
      url: `/v1/requests/req_${tenantBId}`,
      headers: { authorization: "Bearer tenant-a-key" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns a row for the caller's own tenant id", async () => {
    const res = await app("tenant-b").inject({
      method: "GET",
      url: `/v1/requests/req_${tenantBId}`,
      headers: { authorization: "Bearer tenant-b-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe("u2");
  });
});
