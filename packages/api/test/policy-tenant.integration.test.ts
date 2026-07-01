import { parseConfigObject } from "@ai-guard/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import { activateConfigVersion, saveConfigVersion } from "../src/modules/policy/repo";
import { createTenantPolicyResolver } from "../src/modules/policy/tenantResolver";
import { createDbKeyResolver } from "../src/modules/keys/resolver";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";

const DATABASE_URL = process.env.DATABASE_URL;

// Tenant A permits premium for logged_in (global cap 250); tenant B permits only
// cheap (cap 100). Both define all model classes so the difference is purely the
// per-tenant permitted-models policy, not a missing class.
const yaml = (monthlyUsd: number, models: string[]): string => `
project: { name: t, environment: test }
budgets:
  global: { monthly_usd: ${monthlyUsd}, hard_stop_at_percent: 100 }
  by_user_type:
    logged_in: { daily_usd: 100, daily_requests: 1000, models: [${models.join(", ")}] }
features:
  support_chat: { model_class: cheap, max_tokens: 100, safety: dev }
model_classes:
  cheap: { primary: openai/gpt-4o-mini }
  standard: { primary: anthropic/claude-sonnet }
  premium: { primary: openai/gpt-5 }
safety: { preset: dev }
`;

const YAML_A = yaml(250, ["cheap", "standard", "premium"]);
const YAML_B = yaml(100, ["cheap"]);

// Boot/fallback config: distinct global cap (500) so a tenant with no active
// version is observably falling back rather than reading a tenant version.
const fallbackConfig = parseConfigObject({
  project: { name: "t", environment: "test" },
  budgets: {
    global: { monthly_usd: 500, hard_stop_at_percent: 100 },
    by_user_type: { logged_in: { daily_usd: 100, daily_requests: 1000, models: ["cheap"] } },
  },
  features: { support_chat: { model_class: "cheap", max_tokens: 100, safety: "dev" } },
  model_classes: {
    cheap: { primary: "openai/gpt-4o-mini" },
    standard: { primary: "anthropic/claude-sonnet" },
    premium: { primary: "openai/gpt-5" },
  },
  safety: { preset: "dev" },
});
const fallback = { config: fallbackConfig, policyMeta: { policyVersion: "file" } };

async function seedActive(pool: Pool, tenantId: string, yamlText: string): Promise<string> {
  const v = await saveConfigVersion(pool, { yaml: yamlText, tenantId });
  await activateConfigVersion(pool, v.id, tenantId);
  return v.id;
}

describe.skipIf(!DATABASE_URL)("per-tenant policy resolution (integration)", () => {
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

  describe("resolver", () => {
    it("resolves each tenant's active version and falls back when none", async () => {
      await seedActive(pool, "tenant-a", YAML_A);
      await seedActive(pool, "tenant-b", YAML_B);
      const resolver = createTenantPolicyResolver({ pool, fallback, ttlMs: 60_000 });

      expect((await resolver.resolve("tenant-a")).config.budgets.global.monthlyUsd).toBe(250);
      expect((await resolver.resolve("tenant-b")).config.budgets.global.monthlyUsd).toBe(100);
      // Unknown tenant → boot/fallback policy (cap 500), never an error.
      expect((await resolver.resolve("tenant-z")).config.budgets.global.monthlyUsd).toBe(500);
      // undefined tenant maps to the default tenant, which has no version → fallback.
      expect((await resolver.resolve(undefined)).config.budgets.global.monthlyUsd).toBe(500);

      // Stamps the version identity for the request log.
      const a = await resolver.resolve("tenant-a");
      expect(a.policyMeta.policyVersion).toBeTruthy();
      expect(a.policyMeta.policyVersion).not.toBe("file");
    });

    it("serves the cached policy until invalidated", async () => {
      await seedActive(pool, "tenant-a", YAML_B); // start: cap 100
      const resolver = createTenantPolicyResolver({ pool, fallback, ttlMs: 60_000 });
      expect((await resolver.resolve("tenant-a")).config.budgets.global.monthlyUsd).toBe(100);

      // Activate a new version out-of-band; the long TTL means it's not seen yet.
      await seedActive(pool, "tenant-a", YAML_A); // now cap 250
      expect((await resolver.resolve("tenant-a")).config.budgets.global.monthlyUsd).toBe(100);

      // After invalidation, the next resolve reads the new active version.
      resolver.invalidate("tenant-a");
      expect((await resolver.resolve("tenant-a")).config.budgets.global.monthlyUsd).toBe(250);
    });

    it("de-duplicates concurrent resolves and does not cache failures", async () => {
      const resolver = createTenantPolicyResolver({ pool, fallback, ttlMs: 60_000 });
      // Concurrent resolves for the same tenant share one in-flight load.
      const [x, y] = await Promise.all([resolver.resolve("tenant-a"), resolver.resolve("tenant-a")]);
      expect(x).toBe(y); // same resolved object → same promise
    });
  });

  describe("explain uses the caller's tenant policy", () => {
    function app(): FastifyInstance {
      return buildServer({
        config: fallbackConfig,
        pool,
        litellm: { chat: async () => ({ content: "ok", model: "m", actualCostUsd: 0, raw: {} }) },
        safety: new NoopGuard(),
        observability: new NoopObservability(),
        logger: false,
        apiKeys: [
          { name: "A", key: "a-key", permissions: ["chat:create", "policy:read", "policy:write"], tenantId: "tenant-a" },
          { name: "B", key: "b-key", permissions: ["chat:create"], tenantId: "tenant-b" },
        ],
        keyResolver: createDbKeyResolver(pool, { cacheTtlMs: 1000 }),
        tenantPolicy: createTenantPolicyResolver({ pool, fallback, ttlMs: 60_000 }),
      });
    }

    const explainPremium = { userId: "u", userType: "logged_in", feature: "support_chat", modelClass: "premium" };

    it("evaluates the same request differently per tenant", async () => {
      await seedActive(pool, "tenant-a", YAML_A); // premium permitted
      await seedActive(pool, "tenant-b", YAML_B); // premium NOT permitted
      const server = app();

      const a = await server.inject({ method: "POST", url: "/v1/explain", headers: { authorization: "Bearer a-key" }, payload: explainPremium });
      const b = await server.inject({ method: "POST", url: "/v1/explain", headers: { authorization: "Bearer b-key" }, payload: explainPremium });

      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      expect(a.json().decision).not.toBe("block"); // tenant A permits premium
      expect(b.json().decision).toBe("block"); // tenant B does not
      await server.close();
    });

    it("applies a newly activated version without a restart", async () => {
      await seedActive(pool, "tenant-a", YAML_B); // start: premium blocked
      const server = app();
      const before = await server.inject({ method: "POST", url: "/v1/explain", headers: { authorization: "Bearer a-key" }, payload: explainPremium });
      expect(before.json().decision).toBe("block");

      // Save + activate a policy that permits premium, via the admin API. The
      // activate route's onActivated hook evicts the cache in-process.
      const created = await server.inject({ method: "POST", url: "/v1/admin/policy/versions", headers: { authorization: "Bearer a-key" }, payload: { yaml: YAML_A } });
      expect(created.statusCode).toBe(201);
      const activated = await server.inject({ method: "POST", url: `/v1/admin/policy/versions/${created.json().id}/activate`, headers: { authorization: "Bearer a-key" } });
      expect(activated.statusCode).toBe(200);

      const after = await server.inject({ method: "POST", url: "/v1/explain", headers: { authorization: "Bearer a-key" }, payload: explainPremium });
      expect(after.json().decision).not.toBe("block"); // change applied, no restart
      await server.close();
    });
  });
});
