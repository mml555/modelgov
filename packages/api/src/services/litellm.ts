import { getModelPrice, roundUsd } from "@modelgov/policy-engine";
import type { ChatMessage } from "../types";

interface ModelPrice {
  inputPer1k: number;
  outputPer1k: number;
}

// Talks to the LiteLLM proxy (OpenAI-compatible). The proxy owns provider
// credentials and returns the real cost via the `x-litellm-response-cost`
// header — that real cost reconciles the reservation after the call.

export interface LiteLLMChatParams {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Per-call override of the client default timeout (e.g. a short bound for the tiny injection classifier). */
  timeoutMs?: number;
}

export interface LiteLLMChatResult {
  content: string;
  model: string;
  /** Real cost reported by LiteLLM, or computed from token usage; null if unknown. */
  actualCostUsd: number | null;
  inputTokens?: number;
  outputTokens?: number;
  raw: unknown;
}

/**
 * A provider-side failure (network error, timeout, 5xx, or 429). This is the
 * signal the orchestrator uses to re-evaluate with forceFallback and retry on
 * the fallback model. 4xx client errors do NOT use this type.
 */
export class ProviderError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
    this.status = status;
  }
}

/** A non-retryable client/config error from LiteLLM (4xx other than 429). */
export class LiteLLMClientError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "LiteLLMClientError";
    this.status = status;
    this.body = body;
  }
}

/** Terminal value of a streamed completion (returned by the chatStream generator). */
export interface LiteLLMStreamFinal {
  model: string;
  actualCostUsd: number | null;
  inputTokens?: number;
  outputTokens?: number;
}

export interface LiteLLMEmbeddingParams {
  model: string;
  /** One or more texts to embed. */
  input: string[];
  timeoutMs?: number;
}

export interface LiteLLMEmbeddingResult {
  /** One vector per input, in the same order. */
  embeddings: number[][];
  model: string;
  /** Real cost reported by LiteLLM, or computed from token usage; null if unknown. */
  actualCostUsd: number | null;
  /** Prompt tokens the provider billed (embeddings have no completion tokens). */
  inputTokens?: number;
  raw: unknown;
}

export interface LiteLLMStreamParams extends LiteLLMChatParams {
  /** Aborts the upstream request (e.g. on client disconnect). */
  signal?: AbortSignal;
}

export interface LiteLLMClient {
  chat(params: LiteLLMChatParams): Promise<LiteLLMChatResult>;
  /**
   * Stream a completion. Yields text deltas as they arrive and RETURNS the
   * terminal usage/cost. Throws ProviderError before the first delta on a
   * connection/5xx failure (fallback-eligible by the caller); an error after
   * streaming has begun propagates from the generator (no mid-stream fallback).
   */
  chatStream?(
    params: LiteLLMStreamParams,
  ): AsyncGenerator<{ delta: string }, LiteLLMStreamFinal, void>;
  /**
   * Embed one or more texts via the proxy's OpenAI-compatible /embeddings route.
   * Optional so existing test fakes (chat-only) keep compiling; the route returns
   * 501 when a deployment's client doesn't implement it.
   */
  embed?(params: LiteLLMEmbeddingParams): Promise<LiteLLMEmbeddingResult>;
}

export interface LiteLLMClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Custom per-model prices (from modelgov.yaml `pricing:`) for the cost fallback. */
  priceOverrides?: Record<string, ModelPrice>;
  /** Retry transient provider errors before surfacing ProviderError. */
  retry?: {
    maxAttempts: number;
    backoffMs: number[];
    retryOn: number[];
    respectRetryAfter: boolean;
  };
}

/**
 * The authoritative cost LiteLLM reports out-of-band: the `x-litellm-response-cost`
 * header, or the `_hidden_params.response_cost` body field (which many proxies
 * populate when the header isn't configured). Null when neither is present.
 * Shared by chat and embeddings so both honor the same sources.
 */
function explicitResponseCost(
  headers: Headers,
  json: Record<string, unknown>,
): number | null {
  const header = headers.get("x-litellm-response-cost");
  if (header) {
    const n = Number(header);
    // Reject NaN / Infinity / negative: a garbage cost header must not be
    // booked verbatim into the budget counter.
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const hidden = (json["_hidden_params"] as Record<string, unknown> | undefined)
    ?.["response_cost"];
  if (typeof hidden === "number" && Number.isFinite(hidden) && hidden >= 0) {
    return hidden;
  }
  return null;
}

function extractCost(
  headers: Headers,
  json: Record<string, unknown>,
  model: string,
  priceOverrides?: Record<string, ModelPrice>,
): number | null {
  const explicit = explicitResponseCost(headers, json);
  if (explicit !== null) return explicit;

  const usage = json["usage"] as
    | { prompt_tokens?: number; completion_tokens?: number }
    | undefined;
  if (usage) {
    const price = getModelPrice(model, priceOverrides);
    return roundUsd(
      ((usage.prompt_tokens ?? 0) / 1000) * price.inputPer1k +
        ((usage.completion_tokens ?? 0) / 1000) * price.outputPer1k,
    );
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(
  retry: NonNullable<LiteLLMClientOptions["retry"]>,
  attempt: number,
  res?: Response,
): number {
  let delay = retry.backoffMs[Math.min(attempt, retry.backoffMs.length - 1)] ?? 1000;
  if (res && retry.respectRetryAfter) {
    const header = res.headers.get("retry-after");
    if (header) {
      const sec = Number(header);
      if (Number.isFinite(sec) && sec > 0) delay = sec * 1000;
    }
  }
  return delay;
}

export function createLiteLLMClient(
  options: LiteLLMClientOptions,
): LiteLLMClient {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retry = options.retry;

  return {
    async chat(params) {
      const maxAttempts = retry?.maxAttempts ?? 1;
      let lastProviderError: ProviderError | undefined;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          params.timeoutMs ?? timeoutMs,
        );
        let res: Response;
        try {
          res = await doFetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(options.apiKey
                ? { authorization: `Bearer ${options.apiKey}` }
                : {}),
            },
            body: JSON.stringify({
              model: params.model,
              messages: params.messages,
              max_tokens: params.maxTokens,
              temperature: params.temperature,
            }),
            signal: controller.signal,
          });
        } catch (err) {
          clearTimeout(timer);
          lastProviderError = new ProviderError(
            `LiteLLM request failed for model '${params.model}'`,
            undefined,
            { cause: err },
          );
          if (retry && attempt < maxAttempts - 1) {
            await sleep(retryDelayMs(retry, attempt));
            continue;
          }
          throw lastProviderError;
        }

        // Keep the abort timer armed until the response BODY is consumed. Clearing
        // it as soon as headers arrive (the old behavior) lets a provider that
        // sends headers then stalls the body hang on res.json()/res.text() until
        // undici's *default* bodyTimeout — correctness must not silently depend on
        // that default (a custom dispatcher without it would outlive the reservation).
        try {
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            if (res.status >= 500 || res.status === 429) {
              lastProviderError = new ProviderError(
                `LiteLLM returned ${res.status} for model '${params.model}': ${body}`,
                res.status,
              );
              if (retry?.retryOn.includes(res.status) && attempt < maxAttempts - 1) {
                await sleep(retryDelayMs(retry, attempt, res));
                continue;
              }
              throw lastProviderError;
            }
            throw new LiteLLMClientError(
              `LiteLLM rejected request (${res.status})`,
              res.status,
              body,
            );
          }

          const json = (await res.json()) as Record<string, unknown>;
          const choices = json["choices"] as
            | Array<{ message?: { content?: string } }>
            | undefined;
          const content = choices?.[0]?.message?.content ?? "";
          const usage = json["usage"] as
            | { prompt_tokens?: number; completion_tokens?: number }
            | undefined;

          return {
            content,
            model: (json["model"] as string) ?? params.model,
            actualCostUsd: extractCost(res.headers, json, params.model, options.priceOverrides),
            inputTokens: usage?.prompt_tokens,
            outputTokens: usage?.completion_tokens,
            raw: json,
          };
        } finally {
          clearTimeout(timer);
        }
      }

      throw (
        lastProviderError ??
        new ProviderError(`LiteLLM request failed for model '${params.model}'`)
      );
    },

    async *chatStream(params) {
      // Bound the stream with an *idle* timeout (reset on the initial response
      // and on every chunk), not a total one — a long but healthy generation
      // must not be killed, only a stalled upstream. Without this, a provider
      // that accepts the stream and then goes silent hangs the request forever,
      // holding its budget reservation until the 15-min stale-lease sweep. Our
      // own controller composes the idle timeout with the caller's signal
      // (client disconnect), and is the only signal passed to fetch.
      const idleMs = params.timeoutMs ?? timeoutMs;
      const controller = new AbortController();
      let timedOut = false;
      const abortStream = (reason: unknown): void => {
        if (!controller.signal.aborted) controller.abort(reason);
      };
      const onCallerAbort = (): void => abortStream(params.signal?.reason);
      if (params.signal) {
        if (params.signal.aborted) abortStream(params.signal.reason);
        else params.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          timedOut = true;
          abortStream(new Error(`LiteLLM stream idle for ${idleMs}ms`));
        }, idleMs);
      };
      const cleanup = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        if (params.signal) params.signal.removeEventListener("abort", onCallerAbort);
      };

      let res: Response;
      try {
        armIdle();
        res = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: params.model,
            messages: params.messages,
            max_tokens: params.maxTokens,
            temperature: params.temperature,
            stream: true,
            // Ask LiteLLM to emit a final usage chunk so we can settle cost.
            stream_options: { include_usage: true },
          }),
          signal: controller.signal,
        });
      } catch (err) {
        cleanup();
        throw new ProviderError(
          timedOut
            ? `LiteLLM stream timed out after ${idleMs}ms for model '${params.model}'`
            : `LiteLLM stream request failed for model '${params.model}'`,
          undefined,
          { cause: err },
        );
      }

      if (!res.ok || !res.body) {
        cleanup();
        const body = await res.text().catch(() => "");
        if (!res.ok && (res.status >= 500 || res.status === 429)) {
          throw new ProviderError(
            `LiteLLM returned ${res.status} for model '${params.model}': ${body}`,
            res.status,
          );
        }
        throw new LiteLLMClientError(
          `LiteLLM rejected stream request (${res.status})`,
          res.status || 502,
          body,
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let model = params.model;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;

      // Parse an OpenAI-style SSE stream: lines of `data: {json}` terminated by
      // `data: [DONE]`, chunks separated by blank lines.
      try {
        for (;;) {
          // Re-arm the idle window before each read; a read that hangs past
          // idleMs aborts the controller, rejecting reader.read() below.
          armIdle();
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") break;
            let chunk: Record<string, unknown>;
            try {
              chunk = JSON.parse(payload);
            } catch {
              continue; // skip malformed keep-alive/comment frames
            }
            if (typeof chunk["model"] === "string") model = chunk["model"] as string;
            const chunkUsage = chunk["usage"] as
              | { prompt_tokens?: number; completion_tokens?: number }
              | null
              | undefined;
            if (chunkUsage) {
              inputTokens = chunkUsage.prompt_tokens ?? inputTokens;
              outputTokens = chunkUsage.completion_tokens ?? outputTokens;
            }
            const choices = chunk["choices"] as
              | Array<{ delta?: { content?: string } }>
              | undefined;
            const delta = choices?.[0]?.delta?.content;
            if (delta) yield { delta };
          }
        }
      } catch (err) {
        throw new ProviderError(
          timedOut
            ? `LiteLLM stream stalled (no data for ${idleMs}ms) for model '${params.model}'`
            : `LiteLLM stream read failed for model '${params.model}'`,
          undefined,
          { cause: err },
        );
      } finally {
        cleanup();
      }

      const actualCostUsd =
        inputTokens != null || outputTokens != null
          ? (() => {
              const price = getModelPrice(model, options.priceOverrides);
              return roundUsd(
                ((inputTokens ?? 0) / 1000) * price.inputPer1k +
                  ((outputTokens ?? 0) / 1000) * price.outputPer1k,
              );
            })()
          : null;

      return { model, actualCostUsd, inputTokens, outputTokens };
    },

    async embed(params) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        params.timeoutMs ?? timeoutMs,
      );
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: params.model, input: params.input }),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        throw new ProviderError(
          `LiteLLM embeddings request failed for model '${params.model}'`,
          undefined,
          { cause: err },
        );
      }

      // Keep the abort timer armed until the response BODY is consumed (see chat()).
      try {
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          if (res.status >= 500 || res.status === 429) {
            throw new ProviderError(
              `LiteLLM returned ${res.status} for embedding model '${params.model}': ${body}`,
              res.status,
            );
          }
          throw new LiteLLMClientError(
            `LiteLLM rejected embeddings request (${res.status})`,
            res.status,
            body,
          );
        }

        const json = (await res.json()) as Record<string, unknown>;
        const data = json["data"] as Array<{ embedding?: number[]; index?: number }> | undefined;
        if (!Array.isArray(data)) {
          throw new ProviderError(
            `LiteLLM embeddings response had no data array for model '${params.model}'`,
          );
        }
        // Order by the provider's `index` so vectors line up with the input array
        // even if the proxy returns them out of order.
        const embeddings = [...data]
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
          .map((d) => d.embedding);
        // Fail loud on a missing/empty vector rather than silently storing `[]`
        // (which would corrupt a KB or fail a fixed-dimension vector column).
        if (embeddings.length !== params.input.length || embeddings.some((e) => !e || e.length === 0)) {
          throw new ProviderError(
            `LiteLLM embeddings response was incomplete for model '${params.model}' (expected ${params.input.length} vectors)`,
          );
        }
        const usage = json["usage"] as { prompt_tokens?: number; total_tokens?: number } | undefined;

        // Embeddings have no completion tokens; use LiteLLM's reported cost, else
        // the price table's input rate. (Shared explicit-cost sources with chat.)
        const cost = (() => {
          const explicit = explicitResponseCost(res.headers, json);
          if (explicit !== null) return explicit;
          const tokens = usage?.prompt_tokens ?? usage?.total_tokens;
          if (typeof tokens === "number") {
            const price = getModelPrice(params.model, options.priceOverrides);
            return roundUsd((tokens / 1000) * price.inputPer1k);
          }
          return null;
        })();

        return {
          // Guaranteed non-empty by the completeness check above.
          embeddings: embeddings as number[][],
          model: (json["model"] as string) ?? params.model,
          actualCostUsd: cost,
          inputTokens: usage?.prompt_tokens ?? usage?.total_tokens,
          raw: json,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
