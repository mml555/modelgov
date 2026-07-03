import type {
  BudgetRemaining,
  ChatRequest,
  ChatResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
  ExplainRequest,
  ExplainResponse,
} from "./types";
import { warnUntrustedUserId } from "./integration";

export interface ModelgovClientOptions {
  baseUrl: string;
  /** Sent as `Authorization: Bearer <apiKey>` when provided. */
  apiKey?: string;
  /** Default request timeout in milliseconds. Set null to disable. Defaults to 60s. */
  timeoutMs?: number | null;
  /** Injectable for tests / custom transports. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Base error carrying the HTTP status and the API's structured error body. */
export class ModelgovError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  /** Stable machine-readable policy/safety reason, when present. */
  readonly reasonCode?: string;
  /** Audit-log id (`req_<n>`) when a request_logs row was written for this decision. */
  readonly auditRequestId?: string;
  /** Remaining budget headroom at decision time, when the API reports it. */
  readonly budgetRemaining?: BudgetRemaining;
  readonly feature?: string;
  readonly userType?: string;
  readonly resolvedModelClass?: string;

  constructor(status: number, code: string, body: unknown) {
    super(`modelgov request failed (${status}): ${code}`);
    this.name = "ModelgovError";
    this.status = status;
    this.code = code;
    this.body = body;

    const err = errorObject(body);
    if (err) {
      const details = errorDetails(err);
      if (typeof details.reasonCode === "string") this.reasonCode = details.reasonCode;
      if (typeof details.auditRequestId === "string") this.auditRequestId = details.auditRequestId;
      if (details.budgetRemaining && typeof details.budgetRemaining === "object") {
        this.budgetRemaining = details.budgetRemaining as BudgetRemaining;
      }
      if (typeof details.feature === "string") this.feature = details.feature;
      if (typeof details.userType === "string") this.userType = details.userType;
      if (typeof details.resolvedModelClass === "string") this.resolvedModelClass = details.resolvedModelClass;
    }
  }
}

/** The `error` object from the API envelope, if present. */
function errorObject(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error: unknown }).error;
    if (e && typeof e === "object") return e as Record<string, unknown>;
  }
  return null;
}

function errorDetails(err: Record<string, unknown>): Record<string, unknown> {
  const details = err.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return { ...err, ...(details as Record<string, unknown>) };
  }
  return err;
}

/** Thrown on 403 policy_blocked / budget_exceeded. */
export class PolicyBlockedError extends ModelgovError {
  constructor(status: number, code: string, body: unknown) {
    super(status, code, body);
    this.name = "PolicyBlockedError";
  }
}

/** Thrown on 403 safety_blocked (PII or prompt injection). */
export class SafetyBlockedError extends ModelgovError {
  constructor(status: number, code: string, body: unknown) {
    super(status, code, body);
    this.name = "SafetyBlockedError";
  }
}

export interface ChatOptions {
  /**
   * Sent as the `Idempotency-Key` header. Retrying with the same key replays
   * the first result instead of re-charging budget / re-calling the model.
   */
  idempotencyKey?: string;
  /** Per-request timeout in milliseconds. Set null to disable. */
  timeoutMs?: number | null;
  /** Optional caller cancellation signal. */
  signal?: AbortSignal;
}

export interface RequestOptions {
  /** Per-request timeout in milliseconds. Set null to disable. */
  timeoutMs?: number | null;
  /** Optional caller cancellation signal. */
  signal?: AbortSignal;
}

/** Terminal metadata frame emitted once a streamed completion finishes. */
export interface ChatStreamDone {
  done: true;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  requestId: string;
}

export interface ModelgovClient {
  chat(request: ChatRequest, options?: ChatOptions): Promise<ChatResponse>;
  /**
   * Stream a completion as it is generated. Yields text deltas, then a final
   * `ChatStreamDone` metadata frame. Pre-stream failures (policy/safety/budget/
   * provider) throw the same typed errors as `chat()`. Requires the feature's
   * output PII protection to be off (the server rejects otherwise).
   */
  chatStream(
    request: ChatRequest,
    options?: RequestOptions,
  ): AsyncGenerator<string, ChatStreamDone | undefined, void>;
  explain(request: ExplainRequest, options?: RequestOptions): Promise<ExplainResponse>;
  /**
   * Embed one or more texts through the gateway. Policy-checked (feature +
   * userType), budget-reserved, and audited exactly like `chat`. Throws the same
   * typed errors on 403 policy/budget blocks.
   */
  embed(request: EmbeddingsRequest, options?: RequestOptions): Promise<EmbeddingsResponse>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function createModelgovClient(
  options: ModelgovClientOptions,
): ModelgovClient {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const defaultTimeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;

  return {
    async chat(request, opts) {
      warnUntrustedUserId(request.userId);
      const signal = scopedSignal(defaultTimeoutMs, opts);
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/v1/chat`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
            ...(opts?.idempotencyKey
              ? { "idempotency-key": opts.idempotencyKey }
              : {}),
          },
          body: JSON.stringify(request),
          signal: signal.signal,
        });
      } finally {
        signal.cleanup();
      }

      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      if (!res.ok) {
        const code = errorCode(body);
        if (code === "safety_blocked") {
          throw new SafetyBlockedError(res.status, code, body);
        }
        if (code === "policy_blocked" || code === "budget_exceeded") {
          throw new PolicyBlockedError(res.status, code, body);
        }
        throw new ModelgovError(res.status, code, body);
      }

      return body as unknown as ChatResponse;
    },

    async *chatStream(request, opts) {
      warnUntrustedUserId(request.userId);
      const signal = scopedSignal(defaultTimeoutMs, opts);
      try {
        const res = await doFetch(`${baseUrl}/v1/chat`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify({ ...request, stream: true }),
          signal: signal.signal,
        });

        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          const code = errorCode(body);
          if (code === "safety_blocked") throw new SafetyBlockedError(res.status, code, body);
          if (code === "policy_blocked" || code === "budget_exceeded") {
            throw new PolicyBlockedError(res.status, code, body);
          }
          throw new ModelgovError(res.status, code, body);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let done: ChatStreamDone | undefined;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") return done;
            try {
              const parsed = JSON.parse(payload) as Record<string, unknown>;
              if (parsed.done === true) done = parsed as unknown as ChatStreamDone;
              else if (typeof parsed.delta === "string") yield parsed.delta;
            } catch {
              // ignore keep-alive / comment frames
            }
          }
        }
        return done;
      } finally {
        signal.cleanup();
      }
    },

    async explain(request, opts) {
      if (request.userId) warnUntrustedUserId(request.userId);
      const signal = scopedSignal(defaultTimeoutMs, opts);
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/v1/explain`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify(request),
          signal: signal.signal,
        });
      } finally {
        signal.cleanup();
      }

      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new ModelgovError(res.status, errorCode(body), body);
      }

      return body as unknown as ExplainResponse;
    },

    async embed(request, opts) {
      warnUntrustedUserId(request.userId);
      const signal = scopedSignal(defaultTimeoutMs, opts);
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/v1/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify(request),
          signal: signal.signal,
        });
      } finally {
        signal.cleanup();
      }

      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const code = errorCode(body);
        if (code === "policy_blocked" || code === "budget_exceeded") {
          throw new PolicyBlockedError(res.status, code, body);
        }
        throw new ModelgovError(res.status, code, body);
      }

      return body as unknown as EmbeddingsResponse;
    },
  };
}

function scopedSignal(
  defaultTimeoutMs: number | null,
  opts?: RequestOptions,
): { signal?: AbortSignal; cleanup: () => void } {
  const timeoutMs = opts?.timeoutMs === undefined ? defaultTimeoutMs : opts.timeoutMs;
  if (timeoutMs == null && !opts?.signal) return { cleanup: () => {} };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abortFromCaller = () => {
    controller.abort(opts?.signal?.reason ?? new Error("modelgov request aborted"));
  };
  if (opts?.signal?.aborted) {
    abortFromCaller();
  } else {
    opts?.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  if (timeoutMs != null) {
    timer = setTimeout(() => {
      controller.abort(new Error(`modelgov request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function errorCode(body: Record<string, unknown>): string {
  if (typeof body.error === "string") return body.error;
  if (
    body.error &&
    typeof body.error === "object" &&
    "code" in body.error &&
    typeof body.error.code === "string"
  ) {
    return body.error.code;
  }
  return "error";
}
