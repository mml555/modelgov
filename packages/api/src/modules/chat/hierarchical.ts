import {
  evaluateAiRequest,
  evaluateBudgetPath,
  PolicyConfigError,
  type AiRequest,
  type BudgetPathNode,
  type PolicyDecision,
  type UsageSnapshot,
} from "@ai-guard/policy-engine";
import { SafetyServiceError } from "../../services/safety";
import { logRequest } from "../usage/auditLogRepo";
import {
  loadPathSnapshot,
  recordIncurredPathCost,
  reservePath,
  resolvePath,
  settlePath,
  type PathReservation,
} from "../budgets/repo";
import {
  bookSafetyIfAny,
  executeProviderWithFallback,
  recordRejection,
  rejectPolicyBlock,
  rejectSafetyBlock,
  type IncurFn,
  type RejectionCtx,
} from "./lifecycle";
import { createHierarchicalProviderBudget } from "./providerBudget";
import { baseLog, baseObs, chatSuccessBody, fail } from "./mapper";
import type { ChatInput, ChatResult, ChatServiceDeps } from "./types";

// Zero flat usage: hierarchical mode makes the node tree the budget authority,
// so evaluateAiRequest is used only for model-class permission, model/safety
// resolution, and cost estimation — its flat budget gates see no prior spend.
const ZERO_USAGE: UsageSnapshot = {
  userDailyUsdUsed: 0,
  userDailyUsdReserved: 0,
  userDailyRequestsUsed: 0,
  featureMonthlyUsdUsed: 0,
  featureMonthlyUsdReserved: 0,
  globalMonthlyUsdUsed: 0,
  globalMonthlyUsdReserved: 0,
};

// Block reasons from evaluateAiRequest that are NOT about flat budgets and must
// still be honored in hierarchical mode (access control / data governance).
const HONORED_BLOCKS = new Set(["model_class_not_permitted", "data_sensitivity_not_permitted"]);

/**
 * Chat with hierarchical (node-tree) budget enforcement. Isolated from the flat
 * `handleChat` so the default path is untouched. Reserve → call → settle/release
 * runs against the caller's `budgetNodeId` path; a stranded reservation is
 * reconciled by the node-lease sweep.
 */
export async function handleChatHierarchical(
  deps: ChatServiceDeps,
  body: ChatInput,
  leafNodeId: string,
): Promise<ChatResult> {
  const { config, pool, litellm, safety, observability, log } = deps;
  const aiRequest: AiRequest = {
    projectId: body.projectId ?? config.project.name,
    environment: body.environment ?? config.project.environment,
    userId: body.userId,
    userType: body.userType,
    feature: body.feature,
    requestedModelClass: body.modelClass,
    inputTokensEstimate: body.inputTokensEstimate,
    metadata: body.metadata,
  };

  // Model / safety / estimate resolution (flat gates neutralized via ZERO_USAGE).
  let decision: PolicyDecision;
  try {
    decision = evaluateAiRequest({ request: aiRequest, config, usage: ZERO_USAGE });
  } catch (err) {
    if (err instanceof PolicyConfigError) return fail(400, err.code, { detail: err.message }, err.message);
    throw err;
  }
  const rejection: RejectionCtx = { pool, observability, aiRequest, policyMeta: deps.policyMeta };
  if (decision.decision === "block" && decision.reasonCode && HONORED_BLOCKS.has(decision.reasonCode)) {
    // budgetRemaining omitted: the flat gates ran against ZERO_USAGE, so their
    // "remaining" would claim full flat headroom while the node tree governs.
    return rejectPolicyBlock(rejection, decision, { includeBudgetRemaining: false });
  }

  // Resolve the budget path and pre-check every cap before spending.
  const now = new Date();
  const nodes = await resolvePath(pool, leafNodeId);
  if (nodes.length === 0) {
    return fail(400, "invalid_request", { detail: `unknown budgetNodeId '${leafNodeId}'` }, "Unknown budget node");
  }
  // Books already-spent classifier cost against every node on the path.
  const incurSafety: IncurFn = (costUsd) =>
    recordIncurredPathCost(pool, nodes, { costUsd, now, shardKey: body.userId });
  const usage = await loadPathSnapshot(pool, nodes, now);
  const pathNodes: BudgetPathNode[] = nodes.map((n) => {
    const u = usage.get(n.id)!;
    return { id: n.id, kind: n.kind, name: n.name, capUsd: n.capUsd, requestCap: n.requestCap, usedUsd: u.usedUsd, reservedUsd: u.reservedUsd, requestsUsed: u.requestsUsed };
  });
  const preCheck = evaluateBudgetPath({ path: pathNodes, estimatedCostUsd: decision.estimatedCostUsd });
  if (preCheck.decision === "block") {
    await logRequest(pool, { ...baseLog(aiRequest, decision, deps.policyMeta), status: "failed", error: preCheck.reason, reasonCode: "global_monthly_budget_exceeded" });
    observability.recordChat({ ...baseObs(aiRequest, decision), status: "blocked", reason: preCheck.reason });
    return fail(403, "budget_exceeded", { scope: "budget_node", failedNodeId: preCheck.failedNodeId, reason: preCheck.reason }, preCheck.reason);
  }

  // Input safety.
  let messages = body.messages;
  let piiMasked = false;
  let injectionBlocked = false;
  let safetyCostUsd = 0;
  try {
    const s = await safety.inspectInput(messages, decision.safetyPlan);
    messages = s.messages;
    piiMasked = s.piiMasked;
    injectionBlocked = s.injectionBlocked;
    safetyCostUsd = s.safetyCostUsd;
    if (s.action === "block") {
      return rejectSafetyBlock(rejection, incurSafety, {
        decision,
        safetyResult: s,
        safetyCostUsd,
      });
    }
  } catch (err) {
    if (err instanceof SafetyServiceError) {
      log?.error({ err }, "safety backend failure (hierarchical)");
      return fail(503, "safety_unavailable", {}, "Safety service unavailable");
    }
    throw err;
  }

  // Atomic reservation against the path.
  // Reserve model estimate + the input-safety cost already incurred.
  const reservation = await reservePath(pool, { nodes, estimatedCostUsd: decision.estimatedCostUsd + safetyCostUsd, now, shardKey: body.userId });
  if (!reservation.ok || !reservation.reservation) {
    // The path reservation rolled back atomically, but the classifier already
    // spent real money — book it without gating the rejection.
    await bookSafetyIfAny(incurSafety, safetyCostUsd);
    const reason = `budget_exceeded:node:${reservation.failedNodeId}`;
    return recordRejection(
      rejection,
      { ...baseLog(aiRequest, decision, deps.policyMeta), status: "failed", error: reason, reasonCode: "global_monthly_budget_exceeded", ...(safetyCostUsd > 0 ? { actualCostUsd: safetyCostUsd } : {}) },
      { ...baseObs(aiRequest, decision), status: "blocked", reason },
      fail(403, "budget_exceeded", { scope: "budget_node", failedNodeId: reservation.failedNodeId }, reason),
    );
  }
  const held: PathReservation = reservation.reservation;
  const reservedUsd = decision.estimatedCostUsd + safetyCostUsd;
  const providerBudget = createHierarchicalProviderBudget({
    pool,
    nodes,
    now,
    shardKey: body.userId,
    held,
    initialReservedUsd: reservedUsd,
  });
  const provider = await executeProviderWithFallback(
    { litellm, config, usage: ZERO_USAGE, log },
    {
      aiRequest,
      decision,
      messages,
      temperature: body.temperature,
      safetyCostUsd,
      rejection,
      includeBudgetRemaining: false,
    },
    providerBudget,
  );
  if (!provider.ok) return provider.failure;

  const { llm, usedModel, finalDecision, costBasis } = provider;

  // Settle actual cost against every node on the path (plus input-safety spend).
  const actualCostUsd = (llm.actualCostUsd ?? costBasis) + safetyCostUsd;
  try {
    await settlePath(pool, held, actualCostUsd);
  } catch (err) {
    // Cost already incurred; leave the lease for the sweep rather than releasing
    // budget for money that was spent. Mirrors the flat path.
    log?.error({ err }, "hierarchical settle failed; node lease sweep will reconcile");
  }

  // Output safety.
  let content = llm.content;
  try {
    const out = await safety.inspectOutput(content, decision.safetyPlan);
    if (out.action === "block") {
      await logRequest(pool, { ...baseLog(aiRequest, decision, deps.policyMeta), resolvedModel: usedModel, decision: finalDecision, status: "safety_blocked", actualCostUsd, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens, piiMasked, injectionBlocked, safetyFindings: out.findings, error: out.blockReason });
      observability.recordChat({ ...baseObs(aiRequest, decision), decision: finalDecision, status: "safety_blocked", model: usedModel, reason: out.blockReason, actualCostUsd, piiMasked, injectionBlocked });
      return fail(403, "safety_blocked", { reason: out.blockReason, findings: out.findings });
    }
    content = out.content;
    if (out.piiMasked) piiMasked = true;
  } catch (err) {
    if (err instanceof SafetyServiceError) {
      log?.error({ err }, "output safety backend failure (hierarchical)");
      await logRequest(pool, { ...baseLog(aiRequest, decision, deps.policyMeta), resolvedModel: usedModel, decision: finalDecision, status: "failed", actualCostUsd, error: "output_safety_unavailable" });
      return { ...fail(503, "safety_unavailable", {}, "Safety service unavailable"), retryable: false };
    }
    throw err;
  }

  const requestId = await logRequest(pool, { ...baseLog(aiRequest, decision, deps.policyMeta), resolvedModel: usedModel, decision: finalDecision, status: "ok", actualCostUsd, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens, piiMasked, injectionBlocked, traceTags: { ...decision.traceTags, policyDecision: finalDecision } });
  observability.recordChat({ ...baseObs(aiRequest, decision), decision: finalDecision, status: "ok", model: usedModel, input: messages, output: content, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens, actualCostUsd, piiMasked, injectionBlocked });

  return chatSuccessBody({
    content,
    model: usedModel,
    decision: finalDecision,
    reason: decision.reason,
    inputTokens: llm.inputTokens,
    outputTokens: llm.outputTokens,
    estimatedCostUsd: decision.estimatedCostUsd,
    actualCostUsd,
    budgetRemaining: decision.budgetRemaining,
    piiMasked,
    injectionBlocked,
    requestId: requestId ?? "req_unknown",
  });
}
