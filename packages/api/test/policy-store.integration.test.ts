import { parseConfigObject } from "@modelgov/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import {
  activateConfigVersion,
  getActiveConfigVersion,
  listConfigVersions,
  reviewConfigVersion,
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

    it("returns not_found activating an unknown id", async () => {
      expect(await activateConfigVersion(pool, "999999")).toEqual({ ok: false, reason: "not_found" });
    });

    it("saves as approved (activatable) when approval is not required", async () => {
      const v1 = await saveConfigVersion(pool, { yaml: VALID_YAML });
      expect(v1.status).toBe("approved");
      const res = await activateConfigVersion(pool, v1.id);
      expect(res.ok).toBe(true);
    });

    it("saves as proposed and refuses to activate until approved (two-person rule)", async () => {
      const v1 = await saveConfigVersion(pool, {
        yaml: VALID_YAML,
        author: "proposer",
        approvalRequired: true,
      });
      expect(v1.status).toBe("proposed");
      expect(v1.proposedBy).toBe("proposer");

      // Cannot go live while merely proposed.
      expect(await activateConfigVersion(pool, v1.id)).toEqual({ ok: false, reason: "not_approved" });

      // The proposer may not approve their own version.
      expect(
        await reviewConfigVersion(pool, { id: v1.id, decision: "approved", reviewer: "proposer" }),
      ).toEqual({ ok: false, reason: "self_approval" });

      // A different operator approves; now it can be activated.
      const approved = await reviewConfigVersion(pool, {
        id: v1.id,
        decision: "approved",
        reviewer: "approver",
      });
      expect(approved.ok).toBe(true);
      if (approved.ok) {
        expect(approved.record.status).toBe("approved");
        expect(approved.record.reviewedBy).toBe("approver");
      }
      expect((await activateConfigVersion(pool, v1.id)).ok).toBe(true);
    });

    it("blocks self-approval of a legacy proposal stored under the reviewer's old (name) identity", async () => {
      // Proposed before the stable-id change → proposed_by is the display name.
      const v1 = await saveConfigVersion(pool, {
        yaml: VALID_YAML,
        author: "alice",
        approvalRequired: true,
      });
      // The same human now authenticates with a stable id but still carries the
      // old name as an alias — must still be blocked from approving.
      expect(
        await reviewConfigVersion(pool, {
          id: v1.id,
          decision: "approved",
          reviewer: "oidc:sub-123",
          reviewerAliases: ["oidc:sub-123", "alice"],
        }),
      ).toEqual({ ok: false, reason: "self_approval" });
      // A genuinely different operator (no overlapping alias) may approve.
      expect(
        (
          await reviewConfigVersion(pool, {
            id: v1.id,
            decision: "approved",
            reviewer: "oidc:sub-999",
            reviewerAliases: ["oidc:sub-999", "bob"],
          })
        ).ok,
      ).toBe(true);
    });

    it("cannot re-review a version that is no longer proposed", async () => {
      const v1 = await saveConfigVersion(pool, { yaml: VALID_YAML, author: "p", approvalRequired: true });
      await reviewConfigVersion(pool, { id: v1.id, decision: "approved", reviewer: "q" });
      expect(
        await reviewConfigVersion(pool, { id: v1.id, decision: "rejected", reviewer: "q" }),
      ).toEqual({ ok: false, reason: "not_proposed" });
    });

    it("lets an author withdraw (reject) their own proposal", async () => {
      const v1 = await saveConfigVersion(pool, { yaml: VALID_YAML, author: "p", approvalRequired: true });
      const rejected = await reviewConfigVersion(pool, { id: v1.id, decision: "rejected", reviewer: "p" });
      expect(rejected.ok).toBe(true);
      expect(await activateConfigVersion(pool, v1.id)).toEqual({ ok: false, reason: "not_approved" });
    });

    it("returns not_found reviewing an unknown id", async () => {
      expect(
        await reviewConfigVersion(pool, { id: "999999", decision: "approved", reviewer: "x" }),
      ).toEqual({ ok: false, reason: "not_found" });
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

    it("whoami returns the caller's own permissions (used by the console)", async () => {
      const res = await app().inject({ method: "GET", url: "/v1/admin/whoami", headers: writer });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe("pa");
      expect(res.json().permissions).toEqual(expect.arrayContaining(["policy:read", "policy:write"]));
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

    it("previews a proposed config: validates + diffs against active without saving", async () => {
      const server = app();
      // Seed + activate v1.
      const created = await server.inject({ method: "POST", url: "/v1/admin/policy/versions", headers: writer, payload: { yaml: VALID_YAML } });
      await server.inject({ method: "POST", url: `/v1/admin/policy/versions/${created.json().id}/activate`, headers: writer });

      // Preview v2 (raised global cap) — no save.
      const preview = await server.inject({ method: "POST", url: "/v1/admin/policy/preview", headers: writer, payload: { yaml: VALID_YAML_V2 } });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().valid).toBe(true);
      const paths = preview.json().diff.map((d: { path: string }) => d.path);
      expect(paths).toContain("budgets.global.monthly_usd");
      // Preview did not create a new version.
      const list = await server.inject({ method: "GET", url: "/v1/admin/policy/versions", headers: writer });
      expect(list.json().items).toHaveLength(1);
    });

    it("preview reports invalid config without throwing", async () => {
      const res = await app().inject({ method: "POST", url: "/v1/admin/policy/preview", headers: writer, payload: { yaml: INVALID_YAML } });
      expect(res.statusCode).toBe(200);
      expect(res.json().valid).toBe(false);
      expect(res.json().error).toBeTruthy();
    });

    it("diffs one stored version against another", async () => {
      const server = app();
      const v1 = (await server.inject({ method: "POST", url: "/v1/admin/policy/versions", headers: writer, payload: { yaml: VALID_YAML } })).json().id;
      const v2 = (await server.inject({ method: "POST", url: "/v1/admin/policy/versions", headers: writer, payload: { yaml: VALID_YAML_V2 } })).json().id;
      const diff = await server.inject({ method: "GET", url: `/v1/admin/policy/versions/${v2}/diff?against=${v1}`, headers: writer });
      expect(diff.statusCode).toBe(200);
      expect(diff.json().diff.map((d: { path: string }) => d.path)).toContain("budgets.global.monthly_usd");
    });
  });

  describe("approval workflow (admin API)", () => {
    function approvalApp(): FastifyInstance {
      return buildServer({
        config,
        pool,
        litellm: { chat: async () => ({ content: "ok", model: "m", actualCostUsd: 0, raw: {} }) },
        safety: new NoopGuard(),
        observability: new NoopObservability(),
        logger: false,
        policyApprovalRequired: true,
        apiKeys: [
          { name: "proposer", key: "prop-secret", permissions: ["policy:read", "policy:write"] },
          { name: "approver", key: "appr-secret", permissions: ["policy:read", "policy:approve", "audit:read"] },
          // A single operator holding both perms — used to prove the self-approval
          // guard blocks even when permissions alone would allow it.
          { name: "both", key: "both-secret", permissions: ["policy:read", "policy:write", "policy:approve"] },
        ],
        keyResolver: createDbKeyResolver(pool, { cacheTtlMs: 1000 }),
      });
    }
    const proposer = { authorization: "Bearer prop-secret" };
    const approver = { authorization: "Bearer appr-secret" };
    const both = { authorization: "Bearer both-secret" };

    it("enforces propose → approve(by another) → activate", async () => {
      const server = approvalApp();
      const created = await server.inject({
        method: "POST", url: "/v1/admin/policy/versions", headers: proposer, payload: { yaml: VALID_YAML },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().status).toBe("proposed");
      const id = created.json().id as string;

      // A proposed version cannot be activated yet.
      const blocked = await server.inject({ method: "POST", url: `/v1/admin/policy/versions/${id}/activate`, headers: proposer });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error.code).toBe("not_approved");

      // A different operator with policy:approve signs off.
      const approve = await server.inject({ method: "POST", url: `/v1/admin/policy/versions/${id}/approve`, headers: approver });
      expect(approve.statusCode).toBe(200);
      expect(approve.json().status).toBe("approved");

      // Now it activates.
      const activated = await server.inject({ method: "POST", url: `/v1/admin/policy/versions/${id}/activate`, headers: proposer });
      expect(activated.statusCode).toBe(200);

      // Audit records the approve action and the chain stays intact.
      const audit = await server.inject({ method: "GET", url: "/v1/admin/audit", headers: approver });
      const actions = audit.json().items.map((i: { action: string }) => i.action);
      expect(actions).toContain("policy.approve");
      expect((await verifyAuditChain(pool)).ok).toBe(true);
    });

    it("blocks self-approval even when one key holds both policy:write and policy:approve", async () => {
      const server = approvalApp();
      const id = (await server.inject({ method: "POST", url: "/v1/admin/policy/versions", headers: both, payload: { yaml: VALID_YAML } })).json().id;
      const selfApprove = await server.inject({ method: "POST", url: `/v1/admin/policy/versions/${id}/approve`, headers: both });
      expect(selfApprove.statusCode).toBe(403);
      expect(selfApprove.json().error.code).toBe("self_approval");
      // Another holder of policy:approve can still approve it.
      const approve = await server.inject({ method: "POST", url: `/v1/admin/policy/versions/${id}/approve`, headers: approver });
      expect(approve.statusCode).toBe(200);
    });

    it("a policy:write key cannot approve (needs policy:approve)", async () => {
      const server = approvalApp();
      const id = (await server.inject({ method: "POST", url: "/v1/admin/policy/versions", headers: proposer, payload: { yaml: VALID_YAML } })).json().id;
      const res = await server.inject({ method: "POST", url: `/v1/admin/policy/versions/${id}/approve`, headers: proposer });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    });

    it("rejecting a proposal keeps it un-activatable", async () => {
      const server = approvalApp();
      const id = (await server.inject({ method: "POST", url: "/v1/admin/policy/versions", headers: proposer, payload: { yaml: VALID_YAML } })).json().id;
      const rejected = await server.inject({ method: "POST", url: `/v1/admin/policy/versions/${id}/reject`, headers: approver });
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json().status).toBe("rejected");
      const act = await server.inject({ method: "POST", url: `/v1/admin/policy/versions/${id}/activate`, headers: proposer });
      expect(act.statusCode).toBe(409);
    });
  });

  describe("tenant isolation", () => {
    function tenantApp(): FastifyInstance {
      return buildServer({
        config,
        pool,
        litellm: { chat: async () => ({ content: "ok", model: "m", actualCostUsd: 0, raw: {} }) },
        safety: new NoopGuard(),
        observability: new NoopObservability(),
        logger: false,
        apiKeys: [
          { name: "A", key: "a-key", permissions: ["policy:read", "policy:write"], tenantId: "tenant-a" },
          { name: "B", key: "b-key", permissions: ["policy:read", "policy:write"], tenantId: "tenant-b" },
        ],
        keyResolver: createDbKeyResolver(pool, { cacheTtlMs: 1000 }),
      });
    }

    it("scopes policy versions per tenant and blocks cross-tenant activation", async () => {
      const server = tenantApp();
      const created = await server.inject({
        method: "POST",
        url: "/v1/admin/policy/versions",
        headers: { authorization: "Bearer a-key" },
        payload: { yaml: VALID_YAML, note: "tenant A v1" },
      });
      expect(created.statusCode).toBe(201);
      const idA = created.json().id as string;

      // Tenant B cannot see tenant A's versions...
      const listB = await server.inject({ method: "GET", url: "/v1/admin/policy/versions", headers: { authorization: "Bearer b-key" } });
      expect(listB.json().items).toHaveLength(0);

      // ...nor activate them (404, not a cross-tenant takeover).
      const actB = await server.inject({ method: "POST", url: `/v1/admin/policy/versions/${idA}/activate`, headers: { authorization: "Bearer b-key" } });
      expect(actB.statusCode).toBe(404);

      // Tenant A sees and activates its own.
      const listA = await server.inject({ method: "GET", url: "/v1/admin/policy/versions", headers: { authorization: "Bearer a-key" } });
      expect(listA.json().items).toHaveLength(1);
      const actA = await server.inject({ method: "POST", url: `/v1/admin/policy/versions/${idA}/activate`, headers: { authorization: "Bearer a-key" } });
      expect(actA.statusCode).toBe(200);
    });
  });
});
