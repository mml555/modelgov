import { describe, expect, it } from "vitest";
import {
  createLiteLLMClient,
  LiteLLMClientError,
  ProviderError,
} from "../src/services/litellm";

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

const completion = {
  model: "openai/gpt-4o-mini",
  choices: [{ message: { content: "hi there" } }],
  usage: { prompt_tokens: 10, completion_tokens: 20 },
};

describe("LiteLLM client", () => {
  it("returns content + actual cost from the response header", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(completion, { headers: { "x-litellm-response-cost": "0.0123" } });
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });

    const r = await client.chat({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(r.content).toBe("hi there");
    expect(r.actualCostUsd).toBeCloseTo(0.0123, 6);
    expect(r.inputTokens).toBe(10);
    expect(r.outputTokens).toBe(20);
  });

  it("computes cost from token usage when no header is present", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        model: "openai/gpt-4o-mini",
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: 1000, completion_tokens: 1000 },
      });
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });
    const r = await client.chat({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    });
    // 1000/1k * 0.00015 + 1000/1k * 0.0006 = 0.00075
    expect(r.actualCostUsd).toBeCloseTo(0.00075, 9);
  });

  it("uses custom price overrides for the token-usage cost fallback", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        model: "openrouter/exotic",
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: 1000, completion_tokens: 1000 },
      });
    const client = createLiteLLMClient({
      baseUrl: "http://x",
      fetchImpl,
      priceOverrides: { "openrouter/exotic": { inputPer1k: 2, outputPer1k: 4 } },
    });
    const r = await client.chat({ model: "openrouter/exotic", messages: [{ role: "user", content: "x" }] });
    // 1000/1k*2 + 1000/1k*4 = 6
    expect(r.actualCostUsd).toBeCloseTo(6, 6);
  });

  it("throws ProviderError on 5xx (fallback-eligible)", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("upstream down", { status: 503 });
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });
    await expect(
      client.chat({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("throws ProviderError when fetch itself fails", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });
    await expect(
      client.chat({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("throws LiteLLMClientError on 4xx (not fallback-eligible)", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("bad model", { status: 400 });
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });
    await expect(
      client.chat({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(LiteLLMClientError);
  });

  it("throws ProviderError on 429 (fallback-eligible)", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("rate limited", { status: 429 });
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });
    await expect(
      client.chat({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("throws ProviderError on request timeout", async () => {
    const fetchImpl: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const client = createLiteLLMClient({
      baseUrl: "http://x",
      fetchImpl,
      timeoutMs: 5,
    });
    await expect(
      client.chat({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("ignores invalid negative cost headers and falls back to token pricing", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(completion, { headers: { "x-litellm-response-cost": "-1" } });
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });
    const r = await client.chat({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    });
    // 10/1k * 0.00015 + 20/1k * 0.0006
    expect(r.actualCostUsd).toBeCloseTo(0.000013, 9);
  });

  it("streams deltas and returns terminal usage", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const fetchImpl: typeof fetch = async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });
    const deltas: string[] = [];
    const gen = client.chatStream!({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    let step = await gen.next();
    while (!step.done) {
      deltas.push(step.value.delta);
      step = await gen.next();
    }
    expect(deltas.join("")).toBe("hello");
    expect(step.value?.inputTokens).toBe(5);
    expect(step.value?.outputTokens).toBe(2);
  });

  it("throws ProviderError when stream upstream returns 503", async () => {
    const fetchImpl: typeof fetch = async () => new Response("down", { status: 503 });
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });
    const gen = client.chatStream!({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    });
    await expect(async () => {
      for await (const _ of gen) {
        // consume
      }
    }).rejects.toBeInstanceOf(ProviderError);
  });

  it("aborts a stream that stalls before the first byte (idle timeout)", async () => {
    // fetch never resolves until the caller-composed signal aborts.
    const fetchImpl: typeof fetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl, timeoutMs: 30 });
    const gen = client.chatStream!({ model: "m", messages: [{ role: "user", content: "x" }] });
    await expect(gen.next()).rejects.toBeInstanceOf(ProviderError);
  });

  it("aborts a stream that goes silent mid-generation (idle timeout)", async () => {
    // Emit one delta, then stall forever; the body errors when our controller
    // aborts on the idle timeout, so reader.read() rejects.
    const fetchImpl: typeof fetch = async (_url, init) => {
      const signal = init?.signal as AbortSignal;
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
          );
          signal.addEventListener("abort", () => controller.error(new Error("aborted")), {
            once: true,
          });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl, timeoutMs: 30 });
    const gen = client.chatStream!({ model: "m", messages: [{ role: "user", content: "x" }] });
    const first = await gen.next();
    expect(first.value).toEqual({ delta: "hi" });
    await expect(gen.next()).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("LiteLLM embeddings", () => {
  const embResponse = {
    model: "openai/text-embedding-3-small",
    data: [
      { index: 1, embedding: [0.4, 0.5] },
      { index: 0, embedding: [0.1, 0.2] },
    ],
    usage: { prompt_tokens: 7, total_tokens: 7 },
  };

  it("returns vectors ordered by index with cost from the response header", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      // Verify the request shape: /embeddings with model + input.
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.model).toBe("openai/text-embedding-3-small");
      expect(body.input).toEqual(["a", "b"]);
      return jsonResponse(embResponse, { headers: { "x-litellm-response-cost": "0.0002" } });
    };
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });
    const r = await client.embed!({ model: "openai/text-embedding-3-small", input: ["a", "b"] });
    // data came back out of order (index 1 first); embeddings must be re-sorted.
    expect(r.embeddings).toEqual([[0.1, 0.2], [0.4, 0.5]]);
    expect(r.actualCostUsd).toBeCloseTo(0.0002, 6);
    expect(r.inputTokens).toBe(7);
  });

  it("computes cost from prompt tokens when no header is present (price override)", async () => {
    // A large token count so the cost survives the 6-decimal (numeric(12,6))
    // rounding — tiny embedding calls legitimately round to $0.
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        model: "openai/text-embedding-3-small",
        data: [{ index: 0, embedding: [0.1] }],
        usage: { prompt_tokens: 1_000_000, total_tokens: 1_000_000 },
      });
    const client = createLiteLLMClient({
      baseUrl: "http://x",
      fetchImpl,
      priceOverrides: { "openai/text-embedding-3-small": { inputPer1k: 0.00002, outputPer1k: 0 } },
    });
    const r = await client.embed!({ model: "openai/text-embedding-3-small", input: ["a"] });
    // 1_000_000/1000 * 0.00002 = 0.02
    expect(r.actualCostUsd).toBeCloseTo(0.02, 6);
  });

  it("throws ProviderError on a 5xx from the proxy", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: "down" }, { status: 503 });
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });
    await expect(
      client.embed!({ model: "m", input: ["a"] }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("throws LiteLLMClientError on a 4xx from the proxy", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: "bad model" }, { status: 400 });
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });
    await expect(
      client.embed!({ model: "m", input: ["a"] }),
    ).rejects.toBeInstanceOf(LiteLLMClientError);
  });
});
