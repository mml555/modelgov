import { parseConfigObject } from "@modelgov/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import type { LiteLLMChatResult } from "../src/services/litellm";
import { NoopGuard } from "../src/services/safety";
import { NoopObservability } from "../src/services/observability";
import { buildServer } from "../src/server";

// End-to-end cost attribution: a "transaction" is every request_logs row sharing
// one correlation id (the reused x-request-id), spanning LLM calls AND
// externally-ingested non-LLM cost. See docs/design/cost-attribution.md.

const DATABASE_URL = process.env.DATABASE_URL;

const config = parseConfigObject({
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
    by_user_type: {
      logged_in: { daily_usd: 100, daily_requests: 1000, models: ["cheap"] },
    },
  },
  features: {
    doc_review: { safety: "dev", model_class: "cheap", max_tokens: 500 },
  },
  model_classes: {
    cheap: { primary: "openai/gpt-4o-mini", fallback: "anthropic/claude-haiku" },
  },
  safety: { preset: "dev" },
});

const OPS_KEY = "ops-secret-key-value-1234567890";
const VIEWER_KEY = "viewer-secret-key-value-1234567890";
const STAGING_KEY = "staging-secret-key-value-1234567890";

function okResult(model: string): LiteLLMChatResult {
  return { content: `reply from ${model}`, model, actualCostUsd: 0.0002, inputTokens: 12, outputTokens: 8, raw: {} };
}

describe.skipIf(!DATABASE_URL)("cost attribution (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE budget_counters, request_logs, idempotency_keys");
  });

  function app(opts: { externalCost?: { sources: readonly string[]; maxUsd: number } } = {}): FastifyInstance {
    return buildServer({
      config,
      pool,
      litellm: { chat: async (p) => okResult(p.model) },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKeys: [
        {
          name: "ops",
          key: OPS_KEY,
          permissions: ["chat:create", "usage:read", "usage:write", "requests:read"],
        },
        { name: "viewer", key: VIEWER_KEY, permissions: ["usage:read", "requests:read"] },
        // Bound to the "staging" environment — used to assert env-scope on ingest.
        { name: "staging", key: STAGING_KEY, permissions: ["usage:write"], environment: "staging" },
      ],
      externalCost: opts.externalCost ?? { sources: ["azure-di"], maxUsd: 100 },
    });
  }

  const chat = (a: FastifyInstance, correlationId: string) =>
    a.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${OPS_KEY}`, "x-request-id": correlationId },
      payload: { userId: "u1", userType: "logged_in", feature: "doc_review", messages: [{ role: "user", content: "hi" }] },
    });

  const get = (a: FastifyInstance, url: string, key = OPS_KEY) =>
    a.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}` } });

  const postExternal = (a: FastifyInstance, body: Record<string, unknown>, key = OPS_KEY) =>
    a.inject({
      method: "POST",
      url: "/v1/usage/external",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      payload: body,
    });

  it("stamps correlation_id from the reused x-request-id and filters /v1/requests by it", async () => {
    const a = app();
    expect((await chat(a, "review_1")).statusCode).toBe(200);
    expect((await chat(a, "review_1")).statusCode).toBe(200);
    expect((await chat(a, "review_2")).statusCode).toBe(200);

    const r1 = await get(a, "/v1/requests?correlationId=review_1");
    expect(r1.statusCode).toBe(200);
    const items = r1.json().items as Array<{ correlationId?: string }>;
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.correlationId === "review_1")).toBe(true);
  });

  it("rolls up LLM + external cost per transaction, external broken out", async () => {
    const a = app();
    await chat(a, "review_1");
    await chat(a, "review_1");
    const ext = await postExternal(a, { correlationId: "review_1", source: "azure-di", feature: "doc_review", costUsd: 5 });
    expect(ext.statusCode).toBe(201);
    expect(ext.json().correlationId).toBe("review_1");

    const res = await get(a, "/v1/usage/transactions?since=1d");
    expect(res.statusCode).toBe(200);
    const txns = res.json().transactions as Array<Record<string, number | string>>;
    const t = txns.find((x) => x.correlationId === "review_1")!;
    expect(t).toBeDefined();
    expect(t.requests).toBe(2);
    expect(t.externalEvents).toBe(1);
    expect(Number(t.llmCostUsd)).toBeCloseTo(0.0004, 6);
    expect(Number(t.externalCostUsd)).toBeCloseTo(5, 6);
    expect(Number(t.actualCostUsd)).toBeCloseTo(5.0004, 6);
  });

  it("external cost rows do NOT inflate the LLM usage summary request counts", async () => {
    const a = app();
    await chat(a, "review_1");
    await postExternal(a, { correlationId: "review_1", source: "azure-di", feature: "doc_review", costUsd: 3 });

    const res = await get(a, "/v1/usage/summary?since=1d");
    expect(res.statusCode).toBe(200);
    // One LLM request only; the external cost row is excluded from the count.
    expect(res.json().requests).toBe(1);
    expect(res.json().completed).toBe(1);
  });

  it("rejects an unknown source and an over-cap amount", async () => {
    const a = app();
    const badSource = await postExternal(a, { source: "textract", feature: "doc_review", costUsd: 1 });
    expect(badSource.statusCode).toBe(400);
    expect(badSource.json().error.details.detail).toContain("allowlist");

    const overCap = await postExternal(a, { source: "azure-di", feature: "doc_review", costUsd: 500 });
    expect(overCap.statusCode).toBe(400);
    expect(overCap.json().error.details.detail).toContain("EXTERNAL_COST_MAX_USD");
  });

  it("requires usage:write and a configured allowlist", async () => {
    // Viewer holds usage:read but not usage:write.
    const forbidden = await postExternal(app(), { source: "azure-di", feature: "doc_review", costUsd: 1 }, VIEWER_KEY);
    expect(forbidden.statusCode).toBe(403);

    // No sources configured -> endpoint fails closed.
    const disabled = await postExternal(app({ externalCost: { sources: [], maxUsd: 100 } }), {
      source: "azure-di",
      feature: "doc_review",
      costUsd: 1,
    });
    expect(disabled.statusCode).toBe(400);
    expect(disabled.json().error.code).toBe("external_cost_disabled");
  });

  it("enforces environment scope on external ingest", async () => {
    // STAGING_KEY is bound to environment 'staging'; posting cost tagged 'prod'
    // must be rejected so a scoped key can't attribute cost to another environment.
    const res = await postExternal(
      app(),
      { source: "azure-di", feature: "doc_review", environment: "prod", costUsd: 1 },
      STAGING_KEY,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("environment_mismatch");
  });

  it("falls back to the per-call x-request-id when no explicit correlationId is posted", async () => {
    const a = app();
    const ext = await a.inject({
      method: "POST",
      url: "/v1/usage/external",
      headers: { authorization: `Bearer ${OPS_KEY}`, "content-type": "application/json", "x-request-id": "review_hdr" },
      payload: { source: "azure-di", feature: "doc_review", costUsd: 2 },
    });
    expect(ext.statusCode).toBe(201);
    expect(ext.json().correlationId).toBe("review_hdr");
  });
});
