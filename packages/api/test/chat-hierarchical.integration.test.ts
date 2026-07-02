import { parseConfigObject } from "@ai-guard/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import { createNode, type BudgetNode } from "../src/modules/budgets/repo";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { ProviderError, type LiteLLMClient } from "../src/services/litellm";
import { buildServer } from "../src/server";

const DATABASE_URL = process.env.DATABASE_URL;

// inputTokensEstimate is chosen so each request's estimate ≈ $0.15
// (1e6/1000 * 0.00015 input + 100/1000 * 0.0006 output), making cap math clean.
const BIG_INPUT = 1_000_000;

const config = parseConfigObject({
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
    by_user_type: { logged_in: { daily_usd: 1000, daily_requests: 1000, models: ["cheap"] } },
  },
  features: { support_chat: { safety: "dev", model_class: "cheap", max_tokens: 100 } },
  model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
  safety: { preset: "dev" },
});

const okLiteLLM: LiteLLMClient = {
  chat: async () => ({ content: "ok", model: "openai/gpt-4o-mini", actualCostUsd: 0.15, inputTokens: 1000, outputTokens: 10, raw: {} }),
};
const streamLiteLLM: LiteLLMClient = {
  chat: async () => ({ content: "ok", model: "openai/gpt-4o-mini", actualCostUsd: 0.15, inputTokens: 1000, outputTokens: 10, raw: {} }),
  async *chatStream() {
    yield { delta: "ok" };
    return { model: "openai/gpt-4o-mini", actualCostUsd: 0.15, inputTokens: 1000, outputTokens: 10, raw: {} };
  },
};
const failingLiteLLM: LiteLLMClient = {
  chat: async () => { throw new ProviderError("upstream down"); },
};
// Yields a token, then the provider dies mid-generation (idle timeout / drop).
const midFailStream: LiteLLMClient = {
  chat: async () => ({ content: "ok", model: "openai/gpt-4o-mini", actualCostUsd: 0.15, raw: {} }),
  async *chatStream() {
    yield { delta: "partial output so far" };
    throw new ProviderError("mid-stream boom");
  },
};

describe.skipIf(!DATABASE_URL)("hierarchical budgets — /v1/chat (integration)", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE budget_node_counters, budget_node_leases, budget_nodes, request_logs RESTART IDENTITY CASCADE");
  });

  function app(litellm: LiteLLMClient, hierarchical = true): FastifyInstance {
    return buildServer({
      config,
      pool,
      litellm,
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      // Bind the key to tenant "acme": hierarchical budgets require the caller's
      // tenant to own the node, so an untenanted key can't reach the "acme" tree.
      apiKeys: [{ name: "acme", key: "secret", permissions: ["chat:create"], tenantId: "acme" }],
      hierarchicalBudgets: hierarchical,
    });
  }

  async function tree(orgCap: number): Promise<{ org: BudgetNode; user: BudgetNode }> {
    const org = await createNode(pool, { tenantId: "acme", kind: "org", name: "acme", window: "monthly", capUsd: orgCap });
    const user = await createNode(pool, { tenantId: "acme", parentId: org.id, kind: "user", name: "u1", window: "monthly" });
    return { org, user };
  }

  function post(server: FastifyInstance, budgetNodeId?: string, stream = false) {
    return server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: {
        userId: "u1", userType: "logged_in", feature: "support_chat",
        messages: [{ role: "user", content: "hi" }],
        inputTokensEstimate: BIG_INPUT,
        ...(stream ? { stream: true } : {}),
        ...(budgetNodeId ? { budgetNodeId } : {}),
      },
    });
  }

  async function nodeCounter(id: string) {
    const { rows } = await pool.query("SELECT used_usd, reserved_usd, requests_used FROM budget_node_counters WHERE node_id = $1", [id]);
    const r = rows[0] ?? { used_usd: 0, reserved_usd: 0, requests_used: 0 };
    return { used: Number(r.used_usd), reserved: Number(r.reserved_usd), requests: Number(r.requests_used) };
  }

  async function leaseCount(): Promise<number> {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM budget_node_leases");
    return rows[0].n;
  }

  it("charges the node path and blocks when an ancestor cap is exhausted", async () => {
    const { org, user } = await tree(0.35); // admits 2 × ~$0.15, rejects the 3rd
    const server = app(okLiteLLM);

    const r1 = await post(server, user.id);
    const r2 = await post(server, user.id);
    const r3 = await post(server, user.id);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(403);
    expect(r3.json().error.code).toBe("budget_exceeded");
    expect(r3.json().error.details.failedNodeId).toBe(org.id);

    const c = await nodeCounter(org.id);
    expect(c.used).toBeCloseTo(0.3, 4); // two settled calls at $0.15
    expect(c.reserved).toBeCloseTo(0, 6);
    expect(await leaseCount()).toBe(0); // settled reservations drop their lease
  });

  it("rolls spend up to every node on the path", async () => {
    const { org, user } = await tree(10);
    await post(app(okLiteLLM), user.id);
    expect((await nodeCounter(org.id)).used).toBeCloseTo(0.15, 4);
    expect((await nodeCounter(user.id)).used).toBeCloseTo(0.15, 4);
  });

  it("streams with hierarchical budgets and settles the node path", async () => {
    const { org, user } = await tree(10);
    const res = await post(app(streamLiteLLM), user.id, true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain(`data: ${JSON.stringify({ delta: "ok" })}`);
    expect(res.body).toContain("data: [DONE]");
    expect(res.body).toMatch(/"requestId":"req_/);
    expect((await nodeCounter(org.id)).used).toBeCloseTo(0.15, 4);
    expect((await nodeCounter(user.id)).used).toBeCloseTo(0.15, 4);
    expect(await leaseCount()).toBe(0);
  });

  it("bills partial cost (not a full refund) when a stream fails mid-generation", async () => {
    const { org, user } = await tree(10);
    const res = await post(app(midFailStream), user.id, true);
    expect(res.statusCode).toBe(200); // SSE already committed before the failure
    expect(res.body).toContain("event: error");
    const c = await nodeCounter(org.id);
    // The tokens produced before the failure are billed — NOT refunded in full.
    expect(c.used).toBeGreaterThan(0);
    expect(c.reserved).toBeCloseTo(0, 6); // hold released
    expect(await leaseCount()).toBe(0);
  });

  it("releases the reservation and lease on a provider failure", async () => {
    const { org, user } = await tree(10);
    const res = await post(app(failingLiteLLM), user.id);
    expect(res.statusCode).toBe(502);
    const c = await nodeCounter(org.id);
    expect(c.reserved).toBeCloseTo(0, 6);
    expect(c.requests).toBe(0);
    expect(await leaseCount()).toBe(0);
  });

  it("rejects an unknown budgetNodeId", async () => {
    const res = await post(app(okLiteLLM), "999999");
    expect(res.statusCode).toBe(400);
  });

  it("refuses to bill another tenant's node (cross-tenant isolation), leaving it untouched", async () => {
    const { org, user } = await tree(10); // tenant "acme"
    // A key bound to a DIFFERENT tenant naming acme's node id.
    const intruder = buildServer({
      config,
      pool,
      litellm: okLiteLLM,
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKeys: [{ name: "intruder", key: "intr", permissions: ["chat:create"], tenantId: "evilcorp" }],
      hierarchicalBudgets: true,
    });
    const res = await intruder.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer intr" },
      payload: {
        userId: "u1", userType: "logged_in", feature: "support_chat",
        messages: [{ role: "user", content: "hi" }],
        inputTokensEstimate: BIG_INPUT, budgetNodeId: user.id,
      },
    });
    // Same 400 as a truly-unknown node — existence is not leaked across tenants.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.detail).not.toContain(user.id);
    // acme's node tree must be completely untouched (no billing, no hold).
    const c = await nodeCounter(org.id);
    expect(c.used).toBe(0);
    expect(c.reserved).toBe(0);
  });

  it("honors a structural policy block (disabled tier) — no provider call, 403, not a 200", async () => {
    // daily_requests: 0 disables the tier. Against ZERO_USAGE this is a block the
    // node tree must NOT silently turn into a provider call, and must never ship
    // decision:"block" inside a 200 body.
    const disabledConfig = parseConfigObject({
      project: { name: "test", environment: "test" },
      budgets: {
        global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
        by_user_type: { logged_in: { daily_usd: 1000, daily_requests: 0, models: ["cheap"] } },
      },
      features: { support_chat: { safety: "dev", model_class: "cheap", max_tokens: 100 } },
      model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
      safety: { preset: "dev" },
    });
    let called = 0;
    const server = buildServer({
      config: disabledConfig,
      pool,
      litellm: { chat: async () => { called++; return { content: "x", model: "openai/gpt-4o-mini", actualCostUsd: 0.15, raw: {} }; } },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKeys: [{ name: "acme", key: "secret", permissions: ["chat:create"], tenantId: "acme" }],
      hierarchicalBudgets: true,
    });
    const { user } = await tree(10);
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: {
        userId: "u1", userType: "logged_in", feature: "support_chat",
        messages: [{ role: "user", content: "hi" }],
        inputTokensEstimate: BIG_INPUT, budgetNodeId: user.id,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("policy_blocked");
    expect(called).toBe(0); // provider never called for a blocked request
  });

  it("uses the flat path (no node counters) when no budgetNodeId is given", async () => {
    const { org } = await tree(0.01); // tiny cap — would block hierarchical, but flat path ignores nodes
    const res = await post(app(okLiteLLM)); // no budgetNodeId
    expect(res.statusCode).toBe(200);
    expect((await nodeCounter(org.id)).used).toBe(0); // node tree untouched
  });

  it("bills the key-bound budgetNodeId when the request omits it", async () => {
    const { org, user } = await tree(10);
    // A key bound to the team/user node — the client sends no budgetNodeId.
    const server = buildServer({
      config,
      pool,
      litellm: okLiteLLM,
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKeys: [{ name: "team-key", key: "tk", permissions: ["chat:create"], tenantId: "acme", budgetNodeId: user.id }],
      hierarchicalBudgets: true,
    });
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer tk" },
      payload: { userId: "u1", userType: "logged_in", feature: "support_chat", messages: [{ role: "user", content: "hi" }], inputTokensEstimate: BIG_INPUT },
    });
    expect(res.statusCode).toBe(200);
    expect((await nodeCounter(org.id)).used).toBeCloseTo(0.15, 4); // key's node was billed
  });

  it("ignores the node path when the flag is off", async () => {
    const { org, user } = await tree(0.01);
    const res = await post(app(okLiteLLM, false), user.id); // flag off
    expect(res.statusCode).toBe(200); // flat path admits
    expect((await nodeCounter(org.id)).used).toBe(0);
  });

  it("books classifier spend to the node path when input safety blocks", async () => {
    // Mirrors the flat-path incurred-cost semantics: a blocked request's real
    // classifier spend lands in the nodes' used_usd without a reservation and
    // without gating the block.
    const server = buildServer({
      config,
      pool,
      litellm: okLiteLLM,
      safety: {
        inspectInput: async (messages) => ({
          action: "block" as const,
          messages,
          piiMasked: false,
          injectionBlocked: true,
          findings: [{ type: "prompt_injection", detail: "test" }],
          blockReason: "prompt_injection",
          safetyCostUsd: 0.07,
        }),
        inspectOutput: async (content) => ({
          action: "allow" as const,
          content,
          piiMasked: false,
          findings: [],
        }),
      },
      observability: new NoopObservability(),
      logger: false,
      apiKeys: [{ name: "acme", key: "secret", permissions: ["chat:create"], tenantId: "acme" }],
      hierarchicalBudgets: true,
    });
    const { org, user } = await tree(10);
    const res = await post(server, user.id);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("safety_blocked");

    // Spend rolled up to every node on the path; nothing reserved, no lease.
    for (const nodeId of [org.id, user.id]) {
      const c = await nodeCounter(nodeId);
      expect(c.used).toBeCloseTo(0.07, 6);
      expect(c.reserved).toBeCloseTo(0, 6);
      expect(c.requests).toBe(0);
    }
    expect(await leaseCount()).toBe(0);

    const { rows } = await pool.query("SELECT status, actual_cost_usd FROM request_logs");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("safety_blocked");
    expect(Number(rows[0].actual_cost_usd)).toBeCloseTo(0.07, 6);
  });

  it("honors a data-sensitivity block on the fallback path (releases nodes, audits the block)", async () => {
    // Mirrors the flat-path spec in rejection-audit.integration.test.ts: the
    // provider fails, the forceFallback re-eval blocks because the fallback's
    // provider isn't approved for the feature's data class — the hierarchical
    // path must release the node reservation, audit the block, and never issue
    // a second provider call.
    const sensitiveConfig = parseConfigObject({
      project: { name: "test", environment: "test" },
      budgets: {
        global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
        by_user_type: { logged_in: { daily_usd: 1000, daily_requests: 1000, models: ["cheap"] } },
      },
      features: {
        secure_chat: { safety: "dev", model_class: "cheap", max_tokens: 100, data_sensitivity: "restricted" },
      },
      data_classes: { restricted: { allowed_providers: ["openai"] } },
      model_classes: { cheap: { primary: "openai/gpt-4o-mini", fallback: "anthropic/claude-haiku" } },
      safety: { preset: "dev" },
    });
    const models: string[] = [];
    const server = buildServer({
      config: sensitiveConfig,
      pool,
      litellm: {
        chat: async (p) => {
          models.push(p.model);
          throw new ProviderError("primary down");
        },
      },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKeys: [{ name: "acme", key: "secret", permissions: ["chat:create"], tenantId: "acme" }],
      hierarchicalBudgets: true,
    });
    const { org, user } = await tree(10);
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: {
        userId: "u1", userType: "logged_in", feature: "secure_chat",
        messages: [{ role: "user", content: "restricted data" }],
        budgetNodeId: user.id,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("policy_blocked");
    expect(res.json().error.details.reasonCode).toBe("data_sensitivity_not_permitted");
    // Exactly one provider attempt (the primary); no retry, no unapproved call.
    expect(models).toEqual(["openai/gpt-4o-mini"]);

    // The node reservation and its lease must be fully released.
    const c = await nodeCounter(org.id);
    expect(c.used).toBeCloseTo(0, 6);
    expect(c.reserved).toBeCloseTo(0, 6);
    expect(await leaseCount()).toBe(0);

    const { rows } = await pool.query(
      "SELECT status, decision, reason_code FROM request_logs",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "failed",
      decision: "block",
      reason_code: "data_sensitivity_not_permitted",
    });
  });
});
