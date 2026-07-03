import { randomBytes } from "node:crypto";
import type { TraceTags } from "@modelgov/policy-engine";
import { Langfuse } from "langfuse";
import type { ChatMessage } from "../types";

// Optional observability. The engine/route stay clean: they always call
// recordChat(); a NoopObservability is used unless Langfuse is configured.

export interface ChatObservation {
  userId: string;
  feature: string;
  decision: string;
  status: "ok" | "blocked" | "safety_blocked" | "error";
  model?: string;
  input?: ChatMessage[];
  output?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  reason?: string;
  piiMasked?: boolean;
  injectionBlocked?: boolean;
  traceTags: TraceTags;
  projectId?: string;
  environment?: string;
  /** Host-app metadata (non-authoritative, for traces only). */
  hostMetadata?: Record<string, unknown>;
}

export interface Observability {
  recordChat(observation: ChatObservation): void;
  shutdown(): Promise<void>;
}

export class NoopObservability implements Observability {
  recordChat(_observation: ChatObservation): void {}
  async shutdown(): Promise<void> {}
}

export interface LangfuseOptions {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  captureContent: boolean;
}

export class LangfuseObservability implements Observability {
  private readonly client: Langfuse;
  private readonly captureContent: boolean;

  constructor(opts: LangfuseOptions) {
    this.captureContent = opts.captureContent;
    this.client = new Langfuse({
      publicKey: opts.publicKey,
      secretKey: opts.secretKey,
      baseUrl: opts.baseUrl,
    });
  }

  recordChat(o: ChatObservation): void {
    // Observability must never break a request: enqueue best-effort, swallow.
    try {
      const trace = this.client.trace({
        name: `chat:${o.feature}`,
        userId: o.userId,
        tags: [o.feature, o.decision, o.status],
        input: this.captureContent ? o.input : undefined,
        output: this.captureContent ? o.output : undefined,
        metadata: {
          environment: o.environment,
          projectId: o.projectId,
          modelClass: o.traceTags.modelClass,
          decision: o.decision,
          status: o.status,
          reason: o.reason,
          estimatedCostUsd: o.estimatedCostUsd,
          actualCostUsd: o.actualCostUsd,
          piiMasked: o.piiMasked,
          injectionBlocked: o.injectionBlocked,
          hostMetadata: o.hostMetadata,
        },
      });

      if (o.status === "ok" && o.model) {
        // Legacy `usage` object — populates promptTokens/completionTokens/cost
        // across both Langfuse v2 and v3.
        const usage: {
          input?: number;
          output?: number;
          unit: "TOKENS";
          totalCost?: number;
        } = { unit: "TOKENS" };
        if (typeof o.inputTokens === "number") usage.input = o.inputTokens;
        if (typeof o.outputTokens === "number") usage.output = o.outputTokens;
        if (typeof o.actualCostUsd === "number") usage.totalCost = o.actualCostUsd;

        trace.generation({
          name: "completion",
          model: o.model,
          input: this.captureContent ? o.input : undefined,
          output: this.captureContent ? o.output : undefined,
          usage,
          metadata: { estimatedCostUsd: o.estimatedCostUsd },
        });
      } else {
        trace.event({
          name: o.status,
          level: o.status === "error" ? "ERROR" : "WARNING",
          statusMessage: o.reason,
        });
      }
    } catch {
      // ignore — tracing is non-critical
    }
  }

  async shutdown(): Promise<void> {
    // Bound the final flush so a slow/unreachable Langfuse never hangs shutdown.
    try {
      await Promise.race([
        this.client.shutdownAsync(),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 3000);
          t.unref?.();
        }),
      ]);
    } catch {
      // ignore
    }
  }
}

export interface OtelOptions {
  /** OTLP/HTTP base endpoint; `/v1/traces` is appended. */
  endpoint: string;
  serviceName: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  randomHex?: (bytes: number) => string;
}

/**
 * OpenTelemetry-native tracing via OTLP/HTTP (JSON). Emits one span per chat to
 * any OTLP collector so OTel-standardized shops aren't locked to Langfuse. Kept
 * dependency-free (no OTel SDK) and best-effort: export never blocks or throws.
 */
export class OtelObservability implements Observability {
  private readonly url: string;
  private readonly serviceName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly randomHex: (bytes: number) => string;
  private inFlight = new Set<Promise<unknown>>();

  constructor(opts: OtelOptions) {
    this.url = `${opts.endpoint.replace(/\/$/, "")}/v1/traces`;
    this.serviceName = opts.serviceName;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.randomHex =
      opts.randomHex ?? ((bytes: number) => randomHex(bytes));
  }

  recordChat(o: ChatObservation): void {
    try {
      const nowNanos = `${this.now()}000000`;
      const attrs: Array<{ key: string; value: Record<string, unknown> }> = [
        kv("modelgov.feature", o.feature),
        kv("modelgov.user_id", o.userId),
        kv("modelgov.decision", o.decision),
        kv("modelgov.status", o.status),
        kv("modelgov.model_class", o.traceTags.modelClass),
      ];
      if (o.model) attrs.push(kv("modelgov.model", o.model));
      if (typeof o.actualCostUsd === "number") attrs.push(kvNum("modelgov.cost_usd", o.actualCostUsd));
      if (typeof o.inputTokens === "number") attrs.push(kvInt("modelgov.input_tokens", o.inputTokens));
      if (typeof o.outputTokens === "number") attrs.push(kvInt("modelgov.output_tokens", o.outputTokens));
      if (o.projectId) attrs.push(kv("modelgov.project_id", o.projectId));

      const payload = {
        resourceSpans: [
          {
            resource: { attributes: [kv("service.name", this.serviceName)] },
            scopeSpans: [
              {
                scope: { name: "modelgov" },
                spans: [
                  {
                    traceId: this.randomHex(16),
                    spanId: this.randomHex(8),
                    name: `chat:${o.feature}`,
                    kind: 3, // CLIENT
                    startTimeUnixNano: nowNanos,
                    endTimeUnixNano: nowNanos,
                    attributes: attrs,
                    // OTel status: 1=OK, 2=ERROR.
                    status: { code: o.status === "ok" ? 1 : 2, message: o.reason },
                  },
                ],
              },
            ],
          },
        ],
      };

      const p = this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
        .catch(() => {})
        .finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    } catch {
      // tracing is non-critical
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }
}

function kv(key: string, value: string): { key: string; value: Record<string, unknown> } {
  return { key, value: { stringValue: value } };
}
function kvNum(key: string, value: number): { key: string; value: Record<string, unknown> } {
  return { key, value: { doubleValue: value } };
}
function kvInt(key: string, value: number): { key: string; value: Record<string, unknown> } {
  return { key, value: { intValue: value } };
}
function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function createObservability(opts: {
  provider: "none" | "langfuse" | "otel";
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  captureContent?: boolean;
  otelEndpoint?: string;
  otelServiceName?: string;
}): Observability {
  if (
    opts.provider === "langfuse" &&
    opts.publicKey &&
    opts.secretKey &&
    opts.baseUrl
  ) {
    return new LangfuseObservability({
      publicKey: opts.publicKey,
      secretKey: opts.secretKey,
      baseUrl: opts.baseUrl,
      captureContent: opts.captureContent ?? false,
    });
  }
  if (opts.provider === "otel" && opts.otelEndpoint) {
    return new OtelObservability({
      endpoint: opts.otelEndpoint,
      serviceName: opts.otelServiceName ?? "modelgov",
    });
  }
  return new NoopObservability();
}
