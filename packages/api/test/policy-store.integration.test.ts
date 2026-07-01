import { parseConfigObject } from "@ai-guard/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import {
  activateConfigVersion,
  getActiveConfigVersion,
  listConfigVersions,
  saveConfigVersion,
} from "../src/modules/policy/repo";
import { createDbKeyResolver } from "../src/modules/keys/resolver";
import { verifyAuditChain } from "../src/modules/audit/repo";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";

const DATABASE_URL = process.env.DATABASE_URL;

const VALID_YAML = `
project:
  name: t
  environment: test
budgets:
  global:
    monthly_usd: 100
    hard_stop_at_percent: 100
  by_user_type:
    logged_in: { daily_usd: 1, daily_requests: 10, models: [cheap] }
features:
  support_chat: { model_class: cheap, max_tokens: 100, safety: dev }
model_classes:
  cheap: { primary: openai/gpt-4o-mini }
safety:
  preset: dev
`;

const VALID_YAML_V2 = VALID_YAML.replace("monthly_usd: 100", "monthly_usd: 250");
const INVALID_YAML = "project:\n  name: t\nfeatures: {}\n"; // missing budgets/model_classes

const config = parseConfigObject({
  project: { name: "t", environment: "test" },
  budgets: { global: { monthly_usd: 100, hard_stop_at_percent: 100 }, by_user_type: { logged_in: { daily_usd: 1, daily_requests: 10, models: ["cheap"] } } },
  features: { support_chat: { model_class: "cheap", max_tokens: 100, safety: "dev" } },
  model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
  safety: { preset: "dev" },
});

describe.skipIf(!DATABASE_URL)("dynamic policy store (integration)", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE config_versions, admin_audit_log, api_keys");
  });

  describe("repo", () => {
    it("saves, activates, and reads back the active version", async () => {
      const v1 = await saveConfigVersion(pool, { yaml: VALID_YAML, author: "op", note: "initial" });
      expect(v1.active).toBe(false);
      await activateConfigVersion(pool, v1.id);
      const active = await getActiveConfigVersion(pool);
      expect(active?.record.id).toBe(v1.id);
      expect(active?.config.budgets.global.monthlyUsd).toBe(100);
    });

    it("keeps exactly one active version and supports rollback", async () => {
      const v1 = await saveConfigVersion(pool, { yaml: VALID_YAML });
      const v2 = await saveConfigVersion(pool, { yaml: VALID_YAML_V2 });
      await activateConfigVersion(pool, v1.id);
      await activateConfigVersion(pool, v2.id);
      expect((await getActiveConfigVersion(pool))?.config.budgets.global.monthlyUsd).toBe(250);
      const activeCount = await pool.query("SELECT count(*) FROM config_versions WHERE active");
      expect(Number(activeCount.rows[0].count)).toBe(1);
      // Rollback = activate the prior id.
      await activateConfigVersion(pool, v1.id);
      expect((await getActiveConfigVersion(pool))?.config.budgets.global.monthlyUsd).toBe(100);
    });

    it("rejects an invalid config at save time", async () => {
      await expect(saveConfigVersion(pool, { yaml: INVALID_YAML })).rejects.toThrow();
      expect(await listConfigVersions(pool)).toHaveLength(0);
    });

    it("returns null activating an unknown id", async () => {
      expect(await activateConfigVersion(pool, "999999")).toBeNull();
    });
  });

  describe("admin API", () => {
    function app(): FastifyInstance {
      return buildServer({
        config,
        pool,
        litellm: { chat: async () => ({ content: "ok", model: "m", actualCostUsd: 0, raw: {} }) },
        safety: new NoopGuard(),
        observability: new NoopObservability(),
        logger: false,
        apiKeys: [
          { name: "pa", key: "pa-secret", permissions: ["policy:read", "policy:write", "audit:read"] },
          { name: "ro", key: "ro-secret", permissions: ["policy:read"] },
        ],
        keyResolver: createDbKeyResolver(pool, { cacheTtlMs: 1000 }),
      });
    }
    const writer = { authorization: "Bearer pa-secret" };

    it("saves + activates via the API and records audit", async () => {
      const server = app();
      const created = await server.inject({
        method: "POST",
        url: "/v1/admin/policy/versions",
        headers: writer,
        payload: { yaml: VALID_YAML, note: "v1" },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;

      const activated = await server.inject({
        method: "POST",
        url: `/v1/admin/policy/versions/${id}/activate`,
        headers: writer,
      });
      expect(activated.statusCode).toBe(200);

      const active = await server.inject({ method: "GET", url: "/v1/admin/policy/active", headers: writer });
      expect(active.json().id).toBe(id);

      const audit = await server.inject({ method: "GET", url: "/v1/admin/audit", headers: writer });
      const actions = audit.json().items.map((i: { action: string }) => i.action);
      expect(actions).toContain("policy.activate");
      expect((await verifyAuditChain(pool)).ok).toBe(true);
    });

    it("rejects an invalid config with 400", async () => {
      const res = await app().inject({
        method: "POST",
        url: "/v1/admin/policy/versions",
        headers: writer,
        payload: { yaml: INVALID_YAML },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_config");
    });

    it("denies writes to a read-only key", async () => {
      const res = await app().inject({
        method: "POST",
        url: "/v1/admin/policy/versions",
        headers: { authorization: "Bearer ro-secret" },
        payload: { yaml: VALID_YAML },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
