import { describe, expect, it } from "vitest";
import {
  ModelgovError,
  createModelgovClient,
  PolicyBlockedError,
  SafetyBlockedError,
} from "../src/client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames: string[]): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const baseRequest = {
  userId: "u1",
  userType: "logged_in" as const,
  feature: "support_chat" as const,
  messages: [{ role: "user", content: "hi" }],
};

describe("createModelgovClient", () => {
  it("posts to /v1/chat and returns the parsed response", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    const fetchImpl: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({
        message: { role: "assistant", content: "hello" },
        model: "openai/gpt-4o-mini",
        decision: "allow",
      });
    };
    const client = createModelgovClient({ baseUrl: "http://api/", fetchImpl });
    const res = await client.chat(baseRequest);

    expect(capturedUrl).toBe("http://api/v1/chat");
    expect(capturedBody).toMatchObject({ feature: "support_chat" });
    expect(res.model).toBe("openai/gpt-4o-mini");
  });

  it("throws PolicyBlockedError on a 403 policy_blocked", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        {
          error: {
            code: "policy_blocked",
            message: "Policy blocked",
            details: { reason: "over budget" },
            requestId: "req_1",
          },
        },
        403,
      );
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    await expect(client.chat(baseRequest)).rejects.toBeInstanceOf(PolicyBlockedError);
  });

  it("throws SafetyBlockedError on a 403 safety_blocked", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        {
          error: {
            code: "safety_blocked",
            message: "Safety blocked",
            details: { reason: "prompt_injection" },
            requestId: "req_1",
          },
        },
        403,
      );
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    await expect(client.chat(baseRequest)).rejects.toBeInstanceOf(SafetyBlockedError);
  });

  it("extractDocument posts to /v1/documents/extract and returns the parsed response", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    let idempotencyHeader: string | null = null;
    const fetchImpl: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      idempotencyHeader = new Headers(init?.headers).get("idempotency-key");
      return jsonResponse({
        text: "extracted text",
        pages: 2,
        provider: "azure-di",
        model: "azure-di/prebuilt-layout",
        tables: [{ rowCount: 1, columnCount: 1, cells: [{ rowIndex: 0, columnIndex: 0, content: "cell" }] }],
        fields: { Total: { content: "$5" } },
        decision: "allow",
        cost: { estimatedUsd: 0.02, actualUsd: 0.02 },
        budgetRemaining: null,
        safety: { piiMasked: false },
        requestId: "req_9",
      });
    };
    const client = createModelgovClient({ baseUrl: "http://api/", fetchImpl });
    const res = await client.extractDocument(
      {
        provider: "azure-di",
        userId: "u1",
        userType: "logged_in",
        feature: "doc_review",
        model: "prebuilt-layout",
        document: { base64: "ZmFrZQ==" },
      },
      { idempotencyKey: "idem-doc-1" },
    );

    expect(capturedUrl).toBe("http://api/v1/documents/extract");
    expect(capturedBody).toMatchObject({ provider: "azure-di", model: "prebuilt-layout", document: { base64: "ZmFrZQ==" } });
    expect(idempotencyHeader).toBe("idem-doc-1");
    expect(res.text).toBe("extracted text");
    expect(res.tables?.[0]?.cells[0]?.content).toBe("cell");
    expect(res.fields?.Total?.content).toBe("$5");
  });

  it("extractDocument throws PolicyBlockedError on a 403 budget_exceeded", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        { error: { code: "budget_exceeded", message: "over budget", details: {}, requestId: "req_1" } },
        403,
      );
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    await expect(
      client.extractDocument({
        provider: "tesseract",
        userId: "u1",
        userType: "logged_in",
        feature: "doc_review",
        document: { url: "https://example.com/doc.pdf" },
      }),
    ).rejects.toBeInstanceOf(PolicyBlockedError);
  });

  it("embed posts to /v1/embeddings and returns the parsed response", async () => {
    let capturedUrl = "";
    const fetchImpl: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return jsonResponse({
        embeddings: [[0.1, 0.2]],
        model: "openai/text-embedding-3-small",
        provider: "openai",
        decision: "allow",
        usage: { inputTokens: 3 },
        cost: { estimatedUsd: 0, actualUsd: 0 },
        budgetRemaining: null,
        requestId: "req_e1",
      });
    };
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    const res = await client.embed({ userId: "u1", userType: "logged_in", feature: "rag_ingest", input: "hi" });
    expect(capturedUrl).toBe("http://api/v1/embeddings");
    expect(res.model).toBe("openai/text-embedding-3-small");
  });

  it("explain posts to /v1/explain and returns the parsed response", async () => {
    let capturedUrl = "";
    const fetchImpl: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return jsonResponse({ decision: "allow", requested: {}, resolved: {}, budget: {} });
    };
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    const res = await client.explain({ userId: "u1", userType: "logged_in", feature: "support_chat" });
    expect(capturedUrl).toBe("http://api/v1/explain");
    expect(res.decision).toBe("allow");
  });

  it("exposes typed fields on the thrown error", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        {
          error: {
            code: "budget_exceeded",
            message: "over budget",
            details: {
              reasonCode: "daily_budget_exceeded",
              auditRequestId: "req_42",
              budgetRemaining: { userDailyUsd: 0, featureMonthlyUsd: null, globalMonthlyUsd: 5 },
              feature: "support_chat",
              userType: "logged_in",
              resolvedModelClass: "cheap",
            },
            requestId: "abc",
          },
        },
        403,
      );
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    try {
      await client.chat(baseRequest);
      throw new Error("expected throw");
    } catch (e) {
      const err = e as PolicyBlockedError;
      expect(err).toBeInstanceOf(PolicyBlockedError);
      expect(err.reasonCode).toBe("daily_budget_exceeded");
      expect(err.auditRequestId).toBe("req_42");
      expect(err.budgetRemaining?.globalMonthlyUsd).toBe(5);
      expect(err.feature).toBe("support_chat");
      expect(err.userType).toBe("logged_in");
      expect(err.resolvedModelClass).toBe("cheap");
    }
  });

  it("sends the Authorization header when an apiKey is set", async () => {
    let auth: string | null = null;
    const fetchImpl: typeof fetch = async (_url, init) => {
      auth = new Headers(init?.headers).get("authorization");
      return jsonResponse({ message: { role: "assistant", content: "x" } });
    };
    const client = createModelgovClient({ baseUrl: "http://api", apiKey: "secret", fetchImpl });
    await client.chat(baseRequest);
    expect(auth).toBe("Bearer secret");
  });

  it("aborts a request when the timeout expires", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      observedSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => {
          reject(observedSignal?.reason);
        });
      });
    };
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl, timeoutMs: null });

    await expect(client.chat(baseRequest, { timeoutMs: 1 })).rejects.toThrow(/timed out/);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("chatStream yields deltas and returns the terminal metadata", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return sseResponse([
        JSON.stringify({ delta: "Hel" }),
        JSON.stringify({ delta: "lo" }),
        JSON.stringify({ done: true, model: "m", usage: { inputTokens: 5, outputTokens: 2 }, requestId: "req_9" }),
        "[DONE]",
      ]);
    };
    const client = createModelgovClient({ baseUrl: "http://api", apiKey: "k", fetchImpl });

    const chunks: string[] = [];
    const it = client.chatStream(baseRequest);
    let result = await it.next();
    while (!result.done) {
      chunks.push(result.value);
      result = await it.next();
    }
    expect(capturedBody.stream).toBe(true);
    expect(chunks.join("")).toBe("Hello");
    expect(result.value?.requestId).toBe("req_9");
  });

  it("chatStream raises a mid-stream error frame instead of ending silently", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        `data: ${JSON.stringify({ delta: "Hel" })}\n\n` +
          `event: error\ndata: ${JSON.stringify({ code: "provider_unavailable", message: "Stream interrupted" })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const client = createModelgovClient({ baseUrl: "http://api", apiKey: "k", fetchImpl });
    const it = client.chatStream(baseRequest);
    const first = await it.next();
    expect(first.value).toBe("Hel");
    await expect(it.next()).rejects.toMatchObject({
      code: "provider_unavailable",
      message: expect.stringContaining("Stream interrupted"),
    });
  });

  it("chatStream throws typed errors before streaming begins", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ error: { code: "budget_exceeded", message: "x", details: {}, requestId: "r" } }, 403);
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    const it = client.chatStream(baseRequest);
    await expect(it.next()).rejects.toBeInstanceOf(PolicyBlockedError);
  });

  it("chatStream surfaces the streaming_unsupported 400 as ModelgovError", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ error: { code: "streaming_unsupported", message: "x", details: {}, requestId: "r" } }, 400);
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    const it = client.chatStream(baseRequest);
    await expect(it.next()).rejects.toBeInstanceOf(ModelgovError);
  });

  it("posts to /v1/explain and returns the parsed response", async () => {
    let capturedUrl = "";
    const fetchImpl: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return jsonResponse({
        decision: "block",
        summary: "Decision: block",
        wouldCallModel: false,
      });
    };
    const client = createModelgovClient({ baseUrl: "http://api/", fetchImpl });
    const res = await client.explain({
      userId: "u1",
      userType: "logged_in",
      feature: "support_chat",
      modelClass: "premium",
    });

    expect(capturedUrl).toBe("http://api/v1/explain");
    expect(res.decision).toBe("block");
  });

  it("getUsage builds the query string and sends auth", async () => {
    let capturedUrl = "";
    let auth: string | null = null;
    const fetchImpl: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      auth = new Headers(init?.headers).get("authorization");
      return jsonResponse({ userDailyUsd: 0.24 });
    };
    const client = createModelgovClient({ baseUrl: "http://api", apiKey: "k", fetchImpl });
    const res = await client.getUsage({ userId: "u1", feature: "support_chat" });

    expect(capturedUrl).toBe("http://api/v1/usage?userId=u1&feature=support_chat");
    expect(auth).toBe("Bearer k");
    expect(res).toMatchObject({ userDailyUsd: 0.24 });
  });

  it("getUsageSummary passes since + feature and returns the body", async () => {
    let capturedUrl = "";
    const fetchImpl: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return jsonResponse({ totalUsd: 1.23 });
    };
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    const res = await client.getUsageSummary({ feature: "support_chat", since: "7d" });

    expect(capturedUrl).toBe("http://api/v1/usage/summary?feature=support_chat&since=7d");
    expect(res).toMatchObject({ totalUsd: 1.23 });
  });

  it("getUsageTransactions coerces limit and parses the rollup", async () => {
    let capturedUrl = "";
    const fetchImpl: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return jsonResponse({
        since: "7d",
        limit: 50,
        transactions: [
          {
            correlationId: "req-abc",
            requests: 2,
            externalEvents: 1,
            actualCostUsd: 0.0123,
            llmCostUsd: 0.01,
            externalCostUsd: 0.0023,
            estimatedCostUsd: 0.015,
            firstSeen: "2026-07-09T00:00:00.000Z",
            lastSeen: "2026-07-09T00:00:02.000Z",
          },
        ],
      });
    };
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    const res = await client.getUsageTransactions({ since: "7d", limit: 50 });

    expect(capturedUrl).toBe("http://api/v1/usage/transactions?since=7d&limit=50");
    const [txn] = res.transactions;
    expect(txn?.correlationId).toBe("req-abc");
    expect(txn?.externalCostUsd).toBe(0.0023);
  });

  it("getProviderHealth returns the parsed health and maps 403", async () => {
    const okFetch: typeof fetch = async (url) => {
      expect(String(url)).toBe("http://api/v1/admin/providers/health");
      return jsonResponse({
        status: "degraded",
        models: [
          { model: "openai/gpt-4o-mini", provider: "openai", healthy: true },
          { model: "anthropic/claude", provider: "anthropic", healthy: false, error: "timeout" },
        ],
      });
    };
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl: okFetch });
    const res = await client.getProviderHealth();
    expect(res.status).toBe("degraded");
    const [, second] = res.models;
    expect(second?.healthy).toBe(false);
    expect(second?.error).toBe("timeout");

    const forbidden = createModelgovClient({
      baseUrl: "http://api",
      fetchImpl: async () => jsonResponse({ error: { code: "forbidden" } }, 403),
    });
    await expect(forbidden.getProviderHealth()).rejects.toBeInstanceOf(ModelgovError);
  });

  it("sends x-request-id from options as the correlation header", async () => {
    const seen: (string | null)[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      seen.push(new Headers(init?.headers).get("x-request-id"));
      return jsonResponse({ message: { role: "assistant", content: "x" } });
    };
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    await client.chat(baseRequest, { requestId: "txn-42" });
    await client.chat(baseRequest); // no requestId -> header absent

    expect(seen[0]).toBe("txn-42");
    expect(seen[1]).toBeNull();
  });

  it("forwards requestId on embed, explain, extractDocument, and chatStream", async () => {
    const seen: Record<string, string | null> = {};
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      const path = new URL(String(url)).pathname;
      seen[path] = headers.get("x-request-id");
      if (headers.get("accept") === "text/event-stream") return sseResponse(["[DONE]"]);
      return jsonResponse({
        embeddings: [[0.1]],
        decision: "allow",
        text: "t",
        pages: 1,
        provider: "p",
      });
    };
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    const rid = "txn-99";
    await client.embed(
      { userId: "u1", userType: "logged_in", feature: "rag_ingest", input: "x" },
      { requestId: rid },
    );
    await client.explain(
      { userId: "u1", userType: "logged_in", feature: "support_chat" },
      { requestId: rid },
    );
    await client.extractDocument(
      { userId: "u1", userType: "logged_in", feature: "doc_review", provider: "tesseract", document: { base64: "eA==" } },
      { requestId: rid },
    );
    const it = client.chatStream(baseRequest, { requestId: rid });
    while (!(await it.next()).done) {
      /* drain the stream */
    }

    expect(seen["/v1/embeddings"]).toBe(rid);
    expect(seen["/v1/explain"]).toBe(rid);
    expect(seen["/v1/documents/extract"]).toBe(rid);
    expect(seen["/v1/chat"]).toBe(rid); // chatStream
  });
});
