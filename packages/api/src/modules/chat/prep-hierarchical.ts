import {
  evaluateAiRequest,
  evaluateBudgetPath,
  PolicyConfigError,
  type AiRequest,
  type BudgetPathNode,
  type PolicyDecision,
  type UsageSnapshot,
} from "@modelgov/policy-engine";
import { logRequest } from "../usage/auditLogRepo";
import {
  loadPathSnapshot,
  recordIncurredPathCost,
  reservePath,
  resolvePath,
  type BudgetNode,
  type PathReservation,
} from "../budgets/repo";
import { bookSafetyIfAny, recordRejection, rejectPolicyBlock, type IncurFn, type RejectionCtx } from "./lifecycle";
import { buildAiRequest } from "./prep";
import { auditUnavailableFailure, baseLog, baseObs, fail } from "./mapper";
import type { ChatFailure, ChatInput, ChatServiceDeps } from "./types";

/** Flat gates neutralized — the node tree is the budget authority. */
export const ZERO_USAGE: UsageSnapshot = {
  userDailyUsdUsed: 0,
  userDailyUsdReserved: 0,
  userDailyRequestsUsed: 0,
  featureMonthlyUsdUsed: 0,
  featureMonthlyUsdReserved: 0,
  globalMonthlyUsdUsed: 0,
  globalMonthlyUsdReserved: 0,
};

export type HierarchicalPolicyEval =
  | { ok: true; aiRequest: AiRequest; decision: PolicyDecision; now: Date }
  | { ok: false; failure: ChatFailure };

export async function evaluateHierarchicalPolicy(
  deps: ChatServiceDeps,
  body: ChatInput,
): Promise<HierarchicalPolicyEval> {
  const aiRequest = buildAiRequest(body, deps.config);
  const now = new Date();
  let decision: PolicyDecision;
  try {
    decision = evaluateAiRequest({ request: aiRequest, config: deps.config, usage: ZERO_USAGE });
  } catch (err) {
    if (err instanceof PolicyConfigError) {
      return { ok: false, failure: fail(400, err.code, { detail: err.message }, err.message) };
    }
    throw err;
  }
  return { ok: true, aiRequest, decision, now };
}

export type PathLoadResult =
  | { ok: true; nodes: BudgetNode[] }
  | { ok: false; precheckFailed: true; reason: string; failedNodeId?: string }
  | ChatFailure;

export async function loadHierarchicalPath(
  pool: ChatServiceDeps["pool"],
  leafNodeId: string,
  decision: PolicyDecision,
  now: Date,
  tenantId?: string,
): Promise<PathLoadResult> {
  const nodes = await resolvePath(pool, leafNodeId, tenantId);
  // Both "no such node" and "node owned by another tenant" return the SAME 400
  // with no id echoed back, so a caller can't probe which sequential node ids
  // exist in other tenants. resolvePath already tenant-filters in SQL; the leaf
  // check below is defense-in-depth and also rejects an untenanted caller
  // (tenantId undefined) reaching for any tenant-owned node.
  const leaf = nodes[nodes.length - 1];
  if (!leaf || leaf.tenantId !== tenantId) {
    return fail(400, "invalid_request", { detail: "unknown budgetNodeId" }, "Unknown budget node");
  }
  const usage = await loadPathSnapshot(pool, nodes, now);
  const pathNodes: BudgetPathNode[] = nodes.map((n) => {
    const u = usage.get(n.id)!;
    return {
      id: n.id,
      kind: n.kind,
      name: n.name,
      capUsd: n.capUsd,
      requestCap: n.requestCap,
      usedUsd: u.usedUsd,
      reservedUsd: u.reservedUsd,
      requestsUsed: u.requestsUsed,
    };
  });
  const preCheck = evaluateBudgetPath({ path: pathNodes, estimatedCostUsd: decision.estimatedCostUsd });
  if (preCheck.decision === "block") {
    return {
      ok: false,
      precheckFailed: true,
      reason: preCheck.reason ?? "budget_exceeded",
      failedNodeId: preCheck.failedNodeId,
    };
  }
  return { ok: true, nodes };
}

export function createHierarchicalIncurSafety(
  pool: ChatServiceDeps["pool"],
  nodes: BudgetNode[],
  now: Date,
  shardKey: string,
): IncurFn {
  return (costUsd) => recordIncurredPathCost(pool, nodes, { costUsd, now, shardKey });
}

export type HierarchicalReserveResult =
  | { ok: true; nodes: BudgetNode[]; held: PathReservation; reservedUsd: number; shardKey: string }
  | { ok: false; failure: ChatFailure };

export async function reserveHierarchicalOrReject(
  deps: ChatServiceDeps,
  params: {
    aiRequest: AiRequest;
    decision: PolicyDecision;
    nodes: BudgetNode[];
    safetyCostUsd: number;
    now: Date;
    shardKey: string;
    rejection: RejectionCtx;
    incurSafety: IncurFn;
  },
): Promise<HierarchicalReserveResult> {
  const { aiRequest, decision, nodes, safetyCostUsd, now, shardKey, rejection, incurSafety } = params;
  const reservation = await reservePath(deps.pool, {
    nodes,
    estimatedCostUsd: decision.estimatedCostUsd + safetyCostUsd,
    now,
    shardKey,
  });
  if (!reservation.ok || !reservation.reservation) {
    await bookSafetyIfAny(incurSafety, safetyCostUsd);
    const reason = `budget_exceeded:node:${reservation.failedNodeId}`;
    return {
      ok: false,
      failure: await recordRejection(
        rejection,
        {
          ...baseLog(aiRequest, decision, deps.policyMeta),
          status: "failed",
          error: reason,
          reasonCode: "global_monthly_budget_exceeded",
          ...(safetyCostUsd > 0 ? { actualCostUsd: safetyCostUsd } : {}),
        },
        { ...baseObs(aiRequest, decision), status: "blocked", reason },
        fail(403, "budget_exceeded", { scope: "budget_node", failedNodeId: reservation.failedNodeId }, reason),
        { auditFailureRetryable: safetyCostUsd <= 0 },
      ),
    };
  }
  return {
    ok: true,
    nodes,
    held: reservation.reservation,
    reservedUsd: decision.estimatedCostUsd + safetyCostUsd,
    shardKey,
  };
}

/**
 * A policy `block` in hierarchical mode is always honored. The engine is
 * evaluated against ZERO_USAGE, so the flat *usage-accumulation* gates can never
 * fire here — the node tree owns budget accumulation. Any block that survives
 * ZERO_USAGE is therefore structural: model class not permitted, data
 * sensitivity, a disabled tier (daily_requests: 0), or a single request whose
 * estimate alone exceeds a configured flat cap. None of those may be silently
 * turned into a provider call, and a block decision must never reach the success
 * envelope (where it would ship `decision: "block"` in a 200, violating the
 * response contract). Fail closed: block is block.
 */
export function isHonoredPolicyBlock(decision: PolicyDecision): boolean {
  return decision.decision === "block";
}

export async function rejectHonoredPolicyBlock(
  rejection: RejectionCtx,
  decision: PolicyDecision,
): Promise<ChatFailure> {
  return rejectPolicyBlock(rejection, decision, { includeBudgetRemaining: false });
}

export async function auditPathPrecheckBlock(
  deps: ChatServiceDeps,
  aiRequest: AiRequest,
  decision: PolicyDecision,
  reason: string,
  failedNodeId?: string,
): Promise<ChatFailure> {
  try {
    await logRequest(deps.pool, {
      ...baseLog(aiRequest, decision, deps.policyMeta),
      status: "failed",
      error: reason,
      reasonCode: "global_monthly_budget_exceeded",
    });
  } catch {
    deps.observability.recordChat({
      ...baseObs(aiRequest, decision),
      status: "error",
      reason: "audit_unavailable",
    });
    return auditUnavailableFailure();
  }
  deps.observability.recordChat({ ...baseObs(aiRequest, decision), status: "blocked", reason });
  return fail(
    403,
    "budget_exceeded",
    { scope: "budget_node", failedNodeId, reason },
    reason,
  );
}
