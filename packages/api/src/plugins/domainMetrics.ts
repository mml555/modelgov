import { Counter, type Registry } from "prom-client";
import type { ChatObservation, Observability } from "../services/observability";

/**
 * Domain (business) metrics for the chat control plane — the signals the
 * operations runbooks actually alert on (spend rate, budget-block rate,
 * provider-fallback rate). These sit alongside the RED/process metrics on the
 * same Prometheus registry. Label cardinality is bounded: `feature`, `decision`,
 * and `status` are all drawn from the config / a small fixed enum.
 */
export interface DomainMetrics {
  record(o: ChatObservation): void;
}

export function createDomainMetrics(register: Registry): DomainMetrics {
  const requests = new Counter({
    name: "modelgov_chat_requests_total",
    help: "Chat requests by feature, policy decision, and outcome status.",
    labelNames: ["feature", "decision", "status"] as const,
    registers: [register],
  });
  const cost = new Counter({
    name: "modelgov_chat_cost_usd_total",
    help: "Cumulative settled model+safety cost (USD) by feature.",
    labelNames: ["feature"] as const,
    registers: [register],
  });
  const fallbacks = new Counter({
    name: "modelgov_chat_fallbacks_total",
    help: "Requests served by the fallback model after a primary provider failure.",
    labelNames: ["feature"] as const,
    registers: [register],
  });
  const budgetBlocks = new Counter({
    name: "modelgov_budget_blocks_total",
    help: "Requests rejected because a budget (flat or node) was exhausted.",
    labelNames: ["feature"] as const,
    registers: [register],
  });
  const safetyBlocks = new Counter({
    name: "modelgov_safety_blocks_total",
    help: "Requests blocked by input/output safety (PII or prompt injection).",
    labelNames: ["feature"] as const,
    registers: [register],
  });

  return {
    record(o: ChatObservation): void {
      const feature = o.feature;
      requests.inc({ feature, decision: o.decision, status: o.status });
      if (typeof o.actualCostUsd === "number" && Number.isFinite(o.actualCostUsd) && o.actualCostUsd > 0) {
        cost.inc({ feature }, o.actualCostUsd);
      }
      if (o.decision === "fallback") fallbacks.inc({ feature });
      if (o.status === "blocked" && (o.reason ?? "").startsWith("budget_exceeded")) {
        budgetBlocks.inc({ feature });
      }
      if (o.status === "safety_blocked") safetyBlocks.inc({ feature });
    },
  };
}

/**
 * Wraps another Observability so every recorded chat outcome also increments the
 * domain metrics. Delegates all behavior (including tracing) to the inner impl;
 * metric recording is best-effort and never throws into the request path.
 */
export class MetricsObservability implements Observability {
  constructor(
    private readonly inner: Observability,
    private readonly metrics: DomainMetrics,
  ) {}

  recordChat(observation: ChatObservation): void {
    try {
      this.metrics.record(observation);
    } catch {
      // never let metrics break a request
    }
    this.inner.recordChat(observation);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
