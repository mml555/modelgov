import {
  providerOf,
  roundUsd,
  type AiRequest,
  type BudgetRemaining,
  type PolicyDecision,
} from "@ai-guard/policy-engine";
import type { ChatObservation } from "../../services/observability";
import type { PolicyErrorContext } from "../../policyErrors";
import type { ChatFailure, ChatSuccess } from "./types";

export function fail(
  status: number,
  code: string,
  details: Record<string, unknown>,
  message?: string,
  policy?: PolicyErrorContext,
): ChatFailure {
  return { ok: false, status, code, details, message, policy };
}

export function auditUnavailableFailure(retryable = true): ChatFailure {
  const failure = fail(
    503,
    "audit_unavailable",
    {},
    "Audit log unavailable",
  );
  return retryable ? failure : { ...failure, retryable: false };
}

export function remainingAfter(
  remaining: BudgetRemaining,
  spentUsd: number,
): BudgetRemaining {
  return {
    userDailyUsd: roundUsd(remaining.userDailyUsd - spentUsd),
    featureMonthlyUsd:
      remaining.featureMonthlyUsd === null
        ? null
        : roundUsd(remaining.featureMonthlyUsd - spentUsd),
    globalMonthlyUsd:
      remaining.globalMonthlyUsd === null
        ? null
        : roundUsd(remaining.globalMonthlyUsd - spentUsd),
    // Token headroom is carried through (pre-settlement value) so clients can
    // display it; null when the corresponding token cap is unset.
    userDailyTokens: remaining.userDailyTokens ?? null,
    featureMonthlyTokens: remaining.featureMonthlyTokens ?? null,
    globalMonthlyTokens: remaining.globalMonthlyTokens ?? null,
  };
}

export function chatSuccessBody(params: {
  content: string;
  model: string;
  decision: "allow" | "degrade" | "fallback";
  reason?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  budgetRemaining: BudgetRemaining | null;
  piiMasked: boolean;
  injectionBlocked: boolean;
  /** Present only for grounded features: whether the answer's citations verified. */
  grounded?: boolean;
  requestId: string;
}): ChatSuccess {
  return {
    ok: true,
    body: {
      message: { role: "assistant", content: params.content },
      model: params.model,
      // Derived from the actual model that ran, so it matches `model` even on
      // fallback (equals the engine's resolvedProvider on the normal path).
      provider: providerOf(params.model),
      decision: params.decision,
      reason: params.reason,
      usage: {
        inputTokens: params.inputTokens ?? null,
        outputTokens: params.outputTokens ?? null,
      },
      cost: {
        estimatedUsd: params.estimatedCostUsd,
        actualUsd: params.actualCostUsd,
      },
      budgetRemaining:
        params.budgetRemaining === null
          ? null
          : remainingAfter(params.budgetRemaining, params.actualCostUsd),
      safety: {
        piiMasked: params.piiMasked,
        injectionBlocked: params.injectionBlocked,
        ...(params.grounded === undefined ? {} : { grounded: params.grounded }),
      },
      requestId: params.requestId,
    },
  };
}

export function baseObs(
  request: AiRequest,
  decision: PolicyDecision,
): ChatObservation {
  return {
    userId: request.userId,
    feature: request.feature,
    decision: decision.decision,
    status: "ok",
    estimatedCostUsd: decision.estimatedCostUsd,
    traceTags: decision.traceTags,
    projectId: request.projectId,
    environment: request.environment,
    hostMetadata: request.metadata,
  };
}

export interface PolicyMeta {
  configHash?: string;
  policyVersion?: string;
  tenantId?: string;
}

export function baseLog(
  request: AiRequest,
  decision: PolicyDecision,
  meta?: PolicyMeta & { requestedModelClass?: string },
) {
  return {
    tenantId: meta?.tenantId,
    projectId: request.projectId,
    environment: request.environment,
    userId: request.userId,
    userType: request.userType,
    feature: request.feature,
    modelClass: decision.resolvedModelClass,
    requestedModelClass: meta?.requestedModelClass ?? request.requestedModelClass,
    resolvedModel: decision.resolvedModel,
    decision: decision.decision,
    estimatedCostUsd: decision.estimatedCostUsd,
    reasonCode: decision.reasonCode,
    traceTags: decision.traceTags,
    hostMetadata: request.metadata,
    configHash: meta?.configHash,
    policyVersion: meta?.policyVersion,
  };
}
