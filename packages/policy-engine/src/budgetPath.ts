import { roundUsd } from "./cost";

// Pure hierarchical-budget path evaluation (see docs/design/multi-tenancy.md).
// No I/O: the API layer resolves the node path and loads each node's current
// used/reserved/requests, then passes them here. The rule is IDENTICAL to the
// DB `reservePath` upsert (used + reserved + estimate <= cap; requests + delta
// <= request_cap), so this early pre-check and the concurrency-safe reservation
// agree. The DB reservation remains the authoritative guard; this returns a
// friendly decision + the breaching node before any spend is attempted.

export interface BudgetPathNode {
  id: string;
  /** Advisory, for reason messages. */
  kind?: string;
  name?: string;
  capUsd: number | null;
  requestCap: number | null;
  usedUsd: number;
  reservedUsd: number;
  requestsUsed: number;
}

export type BudgetPathReasonCode =
  | "node_budget_exceeded"
  | "node_request_limit_reached";

export interface NodeRemaining {
  nodeId: string;
  /** null = uncapped on this axis. */
  usdRemaining: number | null;
  requestsRemaining: number | null;
}

export interface EvaluateBudgetPathInput {
  /** Nodes root→leaf. Evaluated in this order so the reason names the outermost breach. */
  path: readonly BudgetPathNode[];
  estimatedCostUsd: number;
  /** Requests this call consumes on each node (default 1). */
  requestDelta?: number;
}

export interface BudgetPathDecision {
  decision: "allow" | "block";
  reasonCode?: BudgetPathReasonCode;
  failedNodeId?: string;
  reason?: string;
  /** Per-node headroom (all nodes, capped or not) for reporting. */
  remaining: NodeRemaining[];
}

function label(n: BudgetPathNode): string {
  return `${n.kind ?? "node"} '${n.name ?? n.id}'`;
}

/**
 * Decide whether a request fits within every cap on its budget path. Returns the
 * first (outermost) breaching node, or `allow` with per-node remaining headroom.
 */
export function evaluateBudgetPath(
  input: EvaluateBudgetPathInput,
): BudgetPathDecision {
  const requestDelta = input.requestDelta ?? 1;
  const estimate = input.estimatedCostUsd;

  const remaining: NodeRemaining[] = input.path.map((n) => ({
    nodeId: n.id,
    usdRemaining:
      n.capUsd == null ? null : roundUsd(n.capUsd - (n.usedUsd + n.reservedUsd)),
    requestsRemaining:
      n.requestCap == null ? null : n.requestCap - n.requestsUsed,
  }));

  for (const n of input.path) {
    if (n.capUsd != null && n.usedUsd + n.reservedUsd + estimate > n.capUsd) {
      return {
        decision: "block",
        reasonCode: "node_budget_exceeded",
        failedNodeId: n.id,
        reason: `budget exceeded at ${label(n)} (cap $${n.capUsd})`,
        remaining,
      };
    }
    if (n.requestCap != null && n.requestsUsed + requestDelta > n.requestCap) {
      return {
        decision: "block",
        reasonCode: "node_request_limit_reached",
        failedNodeId: n.id,
        reason: `request limit reached at ${label(n)} (cap ${n.requestCap})`,
        remaining,
      };
    }
  }

  return { decision: "allow", remaining };
}
