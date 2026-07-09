import { parseConfigObject, type SafetyPlan } from "@modelgov/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import type { LiteLLMChatResult } from "../src/services/litellm";
import { NoopGuard, type OutputSafetyResult, type SafetyGuard } from "../src/services/safety";
import { NoopObservability } from "../src/services/observability";
import {
  DocumentProviderError,
  type DocumentAiClient,
  type DocumentProviderAdapter,
  type DocumentResult,
} from "../src/services/documents";
import { buildServer } from "../src/server";

// Governed document extraction rides the same reserve/settle/audit/billing spine
// as embeddings, but priced per page and with PII masked on the OUTPUT. It is a
// first-class request (decision allow) that rolls up with LLM calls under one
// correlation id. See docs/design/document-ai.md.

const DATABASE_URL = process.env.DATABASE_URL;
const PER_PAGE_USD = 0.01;
const KEY = "docs-secret-key-value-1234567890";

const config = parseConfigObject({
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
    by_user_type: { logged_in: { daily_usd: 1, daily_requests: 1000, models: ["cheap"] } },
  },
  features: { doc_review: { safety: "dev", model_class: "cheap", max_tokens: 500 } },
  model_classes: { cheap: { primary: "openai/gpt-4o-mini", fallback: "anthropic/claude-haiku" } },
  safety: { preset: "dev" },
});

function okChat(model: string): LiteLLMChatResult {
  return { content: "ok", model, actualCostUsd: 0.0002, inputTokens: 5, outputTokens: 3, raw: {} };
}

/** A single-provider ("tesseract") mock document client. */
function mockDocClient(extract: DocumentProviderAdapter["extract"]): DocumentAiClient {
  const adapter: DocumentProviderAdapter = {
    slug: "tesseract",
    supportedInputs: ["base64", "url"],
    perPageUsd: PER_PAGE_USD,
    extract,
  };
  return { providers: () => ["tesseract"], get: (p) => (p === "tesseract" ? adapter : undefined) };
}

const okExtract = async (): Promise<DocumentResult> => ({ text: "hello world", pages: 3, model: "tesseract" });

/** Guard that masks any output text (to prove output PII handling is wired). */
const maskingGuard: SafetyGuard = {
  inspectInput: new NoopGuard().inspectInput,
  async inspectOutput(_content: string, _plan: SafetyPlan): Promise<OutputSafetyResult> {
    return { action: "allow", content: "<MASKED>", piiMasked: true, findings: [{ type: "pii", detail: "US_SSN" }] };
  },
};

describe.skipIf(!DATABASE_URL)("document extraction (integration)", () => {
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

  function app(
    opts: { extract?: DocumentProviderAdapter["extract"]; safety?: SafetyGuard; captureContent?: boolean } = {},
  ): FastifyInstance {
    return buildServer({
      config,
      pool,
      litellm: { chat: async (p) => okChat(p.model) },
      safety: opts.safety ?? new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKeys: [{ name: "ops", key: KEY, permissions: ["chat:create", "usage:read"] }],
      documentClient: mockDocClient(opts.extract ?? okExtract),
      documentMaxPages: 2,
      idempotencyCaptureContent: opts.captureContent,
    });
  }

  const extract = (a: FastifyInstance, body: Record<string, unknown>, correlationId?: string) =>
    a.inject({
      method: "POST",
      url: "/v1/documents/extract",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        ...(correlationId ? { "x-request-id": correlationId } : {}),
      },
      payload: { userId: "u1", userType: "logged_in", feature: "doc_review", provider: "tesseract", ...body },
    });

  const get = (a: FastifyInstance, url: string) =>
    a.inject({ method: "GET", url, headers: { authorization: `Bearer ${KEY}` } });

  it("extracts, settles per-page cost, and writes a governed audit row", async () => {
    const a = app();
    const res = await extract(a, { document: { base64: "ZmFrZQ==" }, pages: 5 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.text).toBe("hello world");
    expect(body.pages).toBe(3);
    // estimate = 5 pages × 0.01; actual = 3 pages × 0.01.
    expect(body.cost.estimatedUsd).toBeCloseTo(0.05, 6);
    expect(body.cost.actualUsd).toBeCloseTo(0.03, 6);

    const { rows } = await pool.query(
      "SELECT decision, status, resolved_model, actual_cost_usd, correlation_id FROM request_logs WHERE user_id='u1'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("allow"); // first-class, NOT 'external'
    expect(rows[0].status).toBe("ok");
    expect(rows[0].resolved_model).toBe("tesseract");
    expect(Number(rows[0].actual_cost_usd)).toBeCloseTo(0.03, 6);
  });

  it("masks PII in the extracted text (output-side safety)", async () => {
    const a = app({ safety: maskingGuard });
    const res = await extract(a, { document: { base64: "ZmFrZQ==" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe("<MASKED>");
    expect(res.json().safety.piiMasked).toBe(true);
  });

  it("blocks and releases the reservation when the estimate exceeds budget", async () => {
    const a = app();
    // 200 pages × 0.01 = $2.00 > the $1 daily cap.
    const res = await extract(a, { document: { base64: "ZmFrZQ==" }, pages: 200 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("budget_exceeded");
    const { rows } = await pool.query(
      "SELECT reserved_usd, used_usd FROM budget_counters WHERE scope='user_daily' AND key='u1'",
    );
    // Reservation never committed (or fully released).
    if (rows.length) {
      expect(Number(rows[0].reserved_usd)).toBeCloseTo(0, 6);
      expect(Number(rows[0].used_usd)).toBeCloseTo(0, 6);
    }
  });

  it("releases the hold on a provider failure", async () => {
    const a = app({
      extract: async () => {
        throw new DocumentProviderError("ocr sidecar down");
      },
    });
    const res = await extract(a, { document: { base64: "ZmFrZQ==" } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("provider_unavailable");
    const { rows } = await pool.query(
      "SELECT reserved_usd, used_usd FROM budget_counters WHERE scope='user_daily' AND key='u1'",
    );
    if (rows.length) {
      expect(Number(rows[0].reserved_usd)).toBeCloseTo(0, 6);
      expect(Number(rows[0].used_usd)).toBeCloseTo(0, 6);
    }
    // The failure is audited.
    const { rows: logs } = await pool.query("SELECT status, error FROM request_logs WHERE user_id='u1'");
    expect(logs[0].status).toBe("failed");
  });

  it("rejects an unconfigured provider and an unsupported source", async () => {
    const a = app();
    const badProvider = await extract(a, { provider: "textract", document: { base64: "ZmFrZQ==" } });
    expect(badProvider.statusCode).toBe(400);
    expect(badProvider.json().error.code).toBe("provider_unavailable");

    const badSource = await extract(a, { document: { s3: "s3://bucket/key" } });
    expect(badSource.statusCode).toBe(400);
    expect(badSource.json().error.code).toBe("unsupported_source");
  });

  it("dedupes a retried extract via Idempotency-Key (provider called once, charged once)", async () => {
    let calls = 0;
    const a = app({
      captureContent: true,
      extract: async () => {
        calls += 1;
        return { text: "once", pages: 3, model: "tesseract" };
      },
    });
    const payload = { userId: "u1", userType: "logged_in", feature: "doc_review", provider: "tesseract", document: { base64: "ZmFrZQ==" } };
    const headers = { authorization: `Bearer ${KEY}`, "content-type": "application/json", "idempotency-key": "idem-1" };

    const r1 = await a.inject({ method: "POST", url: "/v1/documents/extract", headers, payload });
    const r2 = await a.inject({ method: "POST", url: "/v1/documents/extract", headers, payload });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.headers["x-idempotent-replay"]).toBe("false");
    expect(r2.headers["x-idempotent-replay"]).toBe("true");
    expect(r2.json()).toEqual(r1.json()); // replayed verbatim
    expect(calls).toBe(1); // provider called only once

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n, coalesce(sum(actual_cost_usd),0)::float AS spent FROM request_logs WHERE user_id='u1'",
    );
    expect(rows[0].n).toBe(1); // one audit row
    expect(rows[0].spent).toBeCloseTo(0.03, 6); // charged once (3 pages × 0.01)
  });

  it("rolls up with LLM calls under one correlation id and counts in the summary", async () => {
    const a = app();
    // One chat + one document under the same reused x-request-id.
    const chat = await a.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${KEY}`, "x-request-id": "rev1" },
      payload: { userId: "u1", userType: "logged_in", feature: "doc_review", messages: [{ role: "user", content: "hi" }] },
    });
    expect(chat.statusCode).toBe(200);
    const doc = await extract(a, { document: { base64: "ZmFrZQ==" } }, "rev1");
    expect(doc.statusCode).toBe(200);

    const txns = (await get(a, "/v1/usage/transactions?since=1d")).json().transactions as Array<Record<string, number | string>>;
    const t = txns.find((x) => x.correlationId === "rev1")!;
    expect(t).toBeDefined();
    expect(t.requests).toBe(2); // chat + document, both first-class
    expect(t.externalEvents).toBe(0);
    expect(Number(t.actualCostUsd)).toBeGreaterThan(0.02); // ~0.0002 chat + 0.02 doc (2 pages)

    // Both counted in the LLM/governed summary (unlike decision='external' rows).
    const summary = (await get(a, "/v1/usage/summary?since=1d")).json();
    expect(summary.requests).toBe(2);
  });
});
