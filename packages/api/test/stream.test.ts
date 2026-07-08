import { parseConfigObject } from "@modelgov/policy-engine";
import { describe, expect, it } from "vitest";
import { ProviderError, type LiteLLMClient, type LiteLLMStreamFinal } from "../src/services/litellm";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";
import { mockPool } from "./mockPool";

const config = parseConfigObject({
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 100, hard_stop_at_percent: 100 },
    by_user_type: { logged_in: { daily_usd: 1, daily_requests: 10, models: ["cheap"] } },
  },
  features: {
    support_chat: { safety: "dev", model_class: "cheap", max_tokens: 100 },
    pii_chat: { safety: "strict", model_class: "cheap", max_tokens: 100 },
  },
  model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
  safety: { preset: "dev" },
});

/** A LiteLLM fake whose chatStream yields the given deltas then returns final. */
function streamingLiteLLM(
  deltas: string[],
  final: LiteLLMStreamFinal = { model: "openai/gpt-4o-mini", actualCostUsd: 0.001, inputTokens: 5, outputTokens: 3 },
  opts: { throwBeforeFirst?: boolean } = {},
): LiteLLMClient {
  return {
    chat: async () => { throw new Error("chat() should not be called in stream mode"); },
    async *chatStream() {
      if (opts.throwBeforeFirst) throw new ProviderError("upstream down");
      for (const d of deltas) yield { delta: d };
      return final;
    },
  };
}

function app(litellm: LiteLLMClient) {
  return buildServer({
    config,
    pool: mockPool() as never,
    litellm,
    safety: new NoopGuard(),
    observability: new NoopObservability(),
    logger: false,
    apiKey: "secret",
  });
}

const auth = { authorization: "Bearer secret" };
const base = { userId: "u1", userType: "logged_in", messages: [{ role: "user", content: "hi" }] };

describe("SSE streaming", () => {
  it("streams delta frames and a terminal [DONE]", async () => {
    const res = await app(streamingLiteLLM(["Hello", " world"])).inject({
      method: "POST",
      url: "/v1/chat",
      headers: auth,
      payload: { ...base, feature: "support_chat", stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain(`data: ${JSON.stringify({ delta: "Hello" })}`);
    expect(res.body).toContain(`data: ${JSON.stringify({ delta: " world" })}`);
    expect(res.body).toContain("data: [DONE]");
    // Terminal metadata frame carries usage + audit id.
    expect(res.body).toContain('"done":true');
    expect(res.body).toMatch(/"requestId":"req_/);
  });

  it("preserves security headers on the streamed response", async () => {
    const res = await app(streamingLiteLLM(["x"])).inject({
      method: "POST",
      url: "/v1/chat",
      headers: auth,
      payload: { ...base, feature: "support_chat", stream: true },
    });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects streaming when the feature requires output PII protection", async () => {
    const res = await app(streamingLiteLLM(["x"])).inject({
      method: "POST",
      url: "/v1/chat",
      headers: auth,
      payload: { ...base, feature: "pii_chat", stream: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("streaming_unsupported");
  });

  it("rejects streaming combined with an idempotency key", async () => {
    const res = await app(streamingLiteLLM(["x"])).inject({
      method: "POST",
      url: "/v1/chat",
      headers: { ...auth, "idempotency-key": "abc" },
      payload: { ...base, feature: "support_chat", stream: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("idempotency_not_supported");
  });

  it("returns a normal 502 when the provider fails before the first token", async () => {
    const res = await app(streamingLiteLLM([], undefined, { throwBeforeFirst: true })).inject({
      method: "POST",
      url: "/v1/chat",
      headers: auth,
      payload: { ...base, feature: "support_chat", stream: true },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("provider_unavailable");
  });

  it("aborts the upstream and releases the hold on a pre-first-byte client disconnect", async () => {
    // A stream that hangs on the first token until aborted — simulates slow
    // provider TTFB. The client disconnects during that window (before any byte),
    // which must abort the upstream and release the budget hold. Uses a real
    // socket because `inject` can't sever a connection mid-request.
    let captured: AbortSignal | undefined;
    const litellm: LiteLLMClient = {
      chat: async () => { throw new Error("chat() should not be called"); },
      chatStream(params) {
        captured = params.signal;
        return (async function* () {
          await new Promise<void>((_resolve, reject) => {
            params.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          });
          yield { delta: "unreachable" };
          return { model: "openai/gpt-4o-mini", actualCostUsd: 0 } as LiteLLMStreamFinal;
        })();
      },
    };
    const server = app(litellm);
    await server.listen({ port: 0 });
    try {
      const addr = server.server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const ac = new AbortController();
      const req = fetch(`http://127.0.0.1:${port}/v1/chat`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({ ...base, feature: "support_chat", stream: true }),
        signal: ac.signal,
      }).catch(() => undefined); // the abort rejects the fetch
      // Let the server reach the hanging first-token read, then disconnect.
      await new Promise((r) => setTimeout(r, 150));
      ac.abort();
      await req;
      // The server observed the disconnect and aborted the upstream generation.
      for (let i = 0; i < 40 && !captured?.aborted; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(captured?.aborted).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("still serves non-streaming requests normally", async () => {
    const nonStream: LiteLLMClient = {
      chat: async () => ({ content: "ok", model: "openai/gpt-4o-mini", actualCostUsd: 0.001, inputTokens: 5, outputTokens: 2, raw: {} }),
    };
    const res = await app(nonStream).inject({
      method: "POST",
      url: "/v1/chat",
      headers: auth,
      payload: { ...base, feature: "support_chat" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().message.content).toBe("ok");
  });
});
