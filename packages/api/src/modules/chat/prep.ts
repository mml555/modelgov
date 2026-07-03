import {
  evaluateAiRequest,
  PolicyConfigError,
  type ModelgovConfig,
  type AiRequest,
  type PolicyDecision,
  type UsageSnapshot,
} from "@modelgov/policy-engine";
import { SafetyServiceError } from "../../services/safety";
import {
  loadUsageSnapshot,
  recordIncurredCost,
  reserveBudget,
} from "../usage/repo";
import { budgetErrorContext, policyErrorMessage } from "../../policyErrors";
import { handleGlobalBudgetAlert } from "../usage/budgetAlerts";
import {
  bookSafetyIfAny,
  recordRejection,
  rejectSafetyBlock,
  type IncurFn,
  type RejectionCtx,
} from "./lifecycle";
import { baseLog, baseObs, fail } from "./mapper";
import type { ChatFailure, ChatInput, ChatServiceDeps } from "./types";
import type { ChatMessage } from "../../types";

/** Map a validated chat body + config to the engine's request shape. */
export function buildAiRequest(body: ChatInput, config: ModelgovConfig): AiRequest {
  return {
    projectId: body.projectId ?? config.project.name,
    environment: body.environment ?? config.project.environment,
    userId: body.userId,
    userType: body.userType,
    feature: body.feature,
    requestedModelClass: body.modelClass,
    inputTokensEstimate: body.inputTokensEstimate,
    metadata: body.metadata,
  };
}

export type FlatPolicyEval =
  | { ok: true; aiRequest: AiRequest; decision: PolicyDecision; usage: UsageSnapshot; now: Date }
  | { ok: false; failure: ChatFailure };

/** Load flat usage, evaluate policy, and map config errors to 400 responses. */
export async function evaluateFlatPolicy(
  deps: ChatServiceDeps,
  body: ChatInput,
): Promise<FlatPolicyEval> {
  const { config, pool } = deps;
  const aiRequest = buildAiRequest(body, config);
  const now = new Date();
  const usage = await loadUsageSnapshot(pool, {
    projectId: aiRequest.projectId,
    userId: aiRequest.userId,
    feature: aiRequest.feature,
    now,
    tenantId: deps.policyMeta?.tenantId,
  });
  let decision: PolicyDecision;
  try {
    decision = evaluateAiRequest({ request: aiRequest, config, usage });
  } catch (err) {
    if (err instanceof PolicyConfigError) {
      return { ok: false, failure: fail(400, err.code, { detail: err.message }, err.message) };
    }
    throw err;
  }
  return { ok: true, aiRequest, decision, usage, now };
}

/** Fire-and-forget global budget alert when spend crosses the configured threshold. */
export function fireGlobalBudgetAlertIfNeeded(
  deps: ChatServiceDeps,
  usage: UsageSnapshot,
  now: Date,
): void {
  const globalBudget = deps.config.budgets.global;
  if (globalBudget.monthlyUsd <= 0) return;
  const alertThreshold = globalBudget.monthlyUsd * (globalBudget.alertAtPercent / 100);
  const globalSpend = usage.globalMonthlyUsdUsed + usage.globalMonthlyUsdReserved;
  if (globalSpend < alertThreshold) return;
  void handleGlobalBudgetAlert(
    deps.pool,
    deps.budgetAlert,
    {
      globalSpendUsd: globalSpend,
      alertThresholdUsd: alertThreshold,
      alertAtPercent: globalBudget.alertAtPercent,
      monthlyCapUsd: globalBudget.monthlyUsd,
      now,
    },
    deps.log,
  ).catch((err) => deps.log?.error({ err }, "budget alert handling failed"));
}

export function createIncurSafety(
  pool: ChatServiceDeps["pool"],
  aiRequest: AiRequest,
  decision: PolicyDecision,
  now: Date,
  tenantId?: string,
): IncurFn {
  return (costUsd) =>
    recordIncurredCost(pool, {
      projectId: aiRequest.projectId,
      userId: aiRequest.userId,
      feature: aiRequest.feature,
      costUsd,
      caps: decision.reservationCaps,
      now,
      tenantId,
    });
}

export interface InputSafetyOutcome {
  messages: ChatMessage[];
  piiMasked: boolean;
  injectionBlocked: boolean;
  safetyCostUsd: number;
}

/** Run input safety (PII + injection). Returns a failure or the (possibly masked) messages. */
export async function runInputSafety(
  deps: ChatServiceDeps,
  messages: ChatInput["messages"],
  decision: PolicyDecision,
  rejection: RejectionCtx,
  incurSafety: IncurFn,
  logContext = "chat",
): Promise<InputSafetyOutcome | ChatFailure> {
  let working = messages;
  let piiMasked = false;
  let injectionBlocked = false;
  let safetyCostUsd = 0;
  try {
    const safetyResult = await deps.safety.inspectInput(working, decision.safetyPlan);
    working = safetyResult.messages;
    piiMasked = safetyResult.piiMasked;
    injectionBlocked = safetyResult.injectionBlocked;
    safetyCostUsd = safetyResult.safetyCostUsd;
    if (safetyResult.action === "block") {
      return rejectSafetyBlock(rejection, incurSafety, {
        decision,
        safetyResult,
        safetyCostUsd,
      });
    }
  } catch (err) {
    if (err instanceof SafetyServiceError) {
      deps.log?.error({ err }, `safety backend failure (${logContext})`);
      return fail(503, "safety_unavailable", {}, "Safety service unavailable");
    }
    throw err;
  }
  return { messages: working, piiMasked, injectionBlocked, safetyCostUsd };
}

export type FlatReserveResult =
  | { ok: true; leaseId?: string; reservedUsd: number }
  | { ok: false; failure: ChatFailure };

/** Reserve flat budget (model estimate + safety cost) or reject with audit trail. */
export async function reserveFlatBudgetOrReject(
  deps: ChatServiceDeps,
  params: {
    aiRequest: AiRequest;
    decision: PolicyDecision;
    safetyCostUsd: number;
    now: Date;
    rejection: RejectionCtx;
    incurSafety: IncurFn;
  },
): Promise<FlatReserveResult> {
  const { aiRequest, decision, safetyCostUsd, now, rejection, incurSafety } = params;
  const reservation = await reserveBudget(deps.pool, {
    projectId: aiRequest.projectId,
    userId: aiRequest.userId,
    feature: aiRequest.feature,
    estimatedCostUsd: decision.estimatedCostUsd + safetyCostUsd,
    estimatedTokens: decision.estimatedTokens,
    caps: decision.reservationCaps,
    now,
    tenantId: deps.policyMeta?.tenantId,
  });
  if (!reservation.ok) {
    await bookSafetyIfAny(incurSafety, safetyCostUsd);
    const reason = `budget_exceeded:${reservation.failedScope}`;
    const policy = budgetErrorContext(
      reservation.failedScope,
      {
        userId: aiRequest.userId,
        userType: aiRequest.userType,
        feature: aiRequest.feature,
      },
      decision.budgetRemaining,
    );
    return {
      ok: false,
      failure: await recordRejection(
        rejection,
        {
          ...baseLog(aiRequest, decision, deps.policyMeta),
          status: "failed",
          error: reason,
          reasonCode: policy.reasonCode,
          ...(safetyCostUsd > 0 ? { actualCostUsd: safetyCostUsd } : {}),
        },
        { ...baseObs(aiRequest, decision), status: "blocked", reason },
        fail(
          403,
          "budget_exceeded",
          {
            scope: reservation.failedScope,
            reasonCode: policy.reasonCode,
            budgetRemaining: decision.budgetRemaining,
          },
          policyErrorMessage("budget_exceeded", policy),
          policy,
        ),
        { auditFailureRetryable: safetyCostUsd <= 0 },
      ),
    };
  }
  return {
    ok: true,
    leaseId: reservation.leaseId,
    reservedUsd: decision.estimatedCostUsd + safetyCostUsd,
  };
}
