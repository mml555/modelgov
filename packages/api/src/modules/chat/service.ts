import {
  evaluateAiRequest,
  PolicyConfigError,
  type AiRequest,
  type PolicyDecision,
} from "@ai-guard/policy-engine";
import { SafetyServiceError } from "../../services/safety";
import { logRequest } from "../usage/auditLogRepo";
import {
  loadUsageSnapshot,
  recordActualCost,
  recordIncurredCost,
  reserveBudget,
} from "../usage/repo";
import { budgetErrorContext, policyErrorMessage } from "../../policyErrors";
import {
  bookSafetyIfAny,
  executeProviderWithFallback,
  recordRejection,
  rejectPolicyBlock,
  rejectSafetyBlock,
  type IncurFn,
  type RejectionCtx,
} from "./lifecycle";
import { createFlatProviderBudget } from "./providerBudget";
import { baseLog, baseObs, chatSuccessBody, fail } from "./mapper";
import type { ChatInput, ChatResult, ChatServiceDeps } from "./types";
import { handleGlobalBudgetAlert } from "../usage/budgetAlerts";

export async function handleChat(
  deps: ChatServiceDeps,
  body: ChatInput,
): Promise<ChatResult> {
  const { config, pool, litellm, safety, observability, budgetAlert, log } = deps;
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
  const now = new Date();
  const usage = await loadUsageSnapshot(pool, {
    projectId: aiRequest.projectId,
    userId: aiRequest.userId,
    feature: aiRequest.feature,
    now,
  });
  let decision: PolicyDecision;
  try {
    decision = evaluateAiRequest({ request: aiRequest, config, usage });
  } catch (err) {
    if (err instanceof PolicyConfigError) {
      return fail(400, err.code, { detail: err.message }, err.message);
    }
    throw err;
  }

  const globalBudget = config.budgets.global;
  if (globalBudget.monthlyUsd > 0) {
    const alertThreshold =
      globalBudget.monthlyUsd * (globalBudget.alertAtPercent / 100);
    const globalSpend =
      usage.globalMonthlyUsdUsed + usage.globalMonthlyUsdReserved;
    if (globalSpend >= alertThreshold) {
      // Fire-and-forget: the alert claim + webhook must not add a synchronous DB
      // round-trip (and possible latency) to every over-threshold chat request.
      void handleGlobalBudgetAlert(
        pool,
        budgetAlert,
        {
          globalSpendUsd: globalSpend,
          alertThresholdUsd: alertThreshold,
          alertAtPercent: globalBudget.alertAtPercent,
          monthlyCapUsd: globalBudget.monthlyUsd,
          now,
        },
        log,
      ).catch((err) => log?.error({ err }, "budget alert handling failed"));
    }
  }

  const rejection: RejectionCtx = { pool, observability, aiRequest, policyMeta: deps.policyMeta };
  // Books already-spent classifier cost against this request's budget scopes.
  const incurSafety: IncurFn = (costUsd) =>
    recordIncurredCost(pool, {
      projectId: aiRequest.projectId,
      userId: aiRequest.userId,
      feature: aiRequest.feature,
      costUsd,
      caps: decision.reservationCaps,
      now,
    });

  if (decision.decision === "block") {
    return rejectPolicyBlock(rejection, decision);
  }
  let messages = body.messages;
  let piiMasked = false;
  let injectionBlocked = false;
  // Real provider cost of the input safety pass (the injection classifier makes
  // a billable model call). Booked into the settled cost below so classifier
  // spend counts against the budget instead of bypassing accounting.
  let safetyCostUsd = 0;
  try {
    const safetyResult = await safety.inspectInput(messages, decision.safetyPlan);
    messages = safetyResult.messages;
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
      log?.error({ err }, "safety backend failure");
      return fail(
        503,
        "safety_unavailable",
        {},
        "Safety service unavailable",
      );
    }
    throw err;
  }
  // Reserve the model estimate PLUS the input-safety classifier cost already
  // incurred above, so the reservation — not just settlement — accounts for
  // safety spend and the cap can't be overshot by the classifier.
  const reservation = await reserveBudget(pool, {
    projectId: aiRequest.projectId,
    userId: aiRequest.userId,
    feature: aiRequest.feature,
    estimatedCostUsd: decision.estimatedCostUsd + safetyCostUsd,
    estimatedTokens: decision.estimatedTokens,
    caps: decision.reservationCaps,
    now,
  });
  if (!reservation.ok) {
    // The reservation rolled back atomically, but the classifier spend already
    // happened — book it without gating the (already-decided) rejection.
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
    return recordRejection(
      { pool, observability },
      { ...baseLog(aiRequest, decision, deps.policyMeta), status: "failed", error: reason, reasonCode: policy.reasonCode, ...(safetyCostUsd > 0 ? { actualCostUsd: safetyCostUsd } : {}) },
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
    );
  }
  const leaseId = reservation.leaseId;
  const reservedUsd = decision.estimatedCostUsd + safetyCostUsd;
  const providerBudget = createFlatProviderBudget({
    pool,
    aiRequest,
    decision,
    now,
    leaseId,
    initialReservedUsd: reservedUsd,
  });
  const provider = await executeProviderWithFallback(
    { litellm, config, usage, log },
    {
      aiRequest,
      decision,
      messages,
      temperature: body.temperature,
      safetyCostUsd,
      rejection,
    },
    providerBudget,
  );
  if (!provider.ok) return provider.failure;

  const { llm, usedModel, finalDecision, costBasis } = provider;
  const settledReservedUsd = provider.reservedUsd;
  // The model call happened — settle its cost now, regardless of what output
  // safety decides below. This keeps budget accounting consistent across the
  // mask / block / backend-error branches. Include the input safety pass's own
  // provider spend (injection classifier) — the reservation only covered the
  // model call, so the classifier cost is added on top so it is booked too.
  const actualCostUsd = (llm.actualCostUsd ?? costBasis) + safetyCostUsd;
  const actualTokens = (llm.inputTokens ?? 0) + (llm.outputTokens ?? 0);
  try {
    await recordActualCost(pool, {
      projectId: aiRequest.projectId,
      userId: aiRequest.userId,
      feature: aiRequest.feature,
      actualCostUsd,
      estimatedCostUsd: settledReservedUsd,
      actualTokens,
      estimatedTokens: decision.estimatedTokens,
      caps: decision.reservationCaps,
      now,
      leaseId,
    });
    if (actualCostUsd > settledReservedUsd) {
      // Actual exceeded what we reserved (a pricier fallback, or an
      // under-estimate). The spend is booked truthfully — which can push a
      // counter past its cap and block subsequent requests — so surface it
      // rather than overshooting the budget silently.
      log?.warn(
        {
          reservedUsd: settledReservedUsd,
          actualCostUsd,
          model: usedModel,
        },
        "actual cost exceeded the reserved estimate — budget cap may be overshot",
      );
    }
  } catch (err) {
    // The provider call already succeeded and incurred real cost. A settlement
    // failure must not 500 the request (which would release the idempotency key
    // and let a retry re-charge for the call that already ran). Retry the
    // settlement once; if it still fails, LEAVE the reservation in place rather
    // than releasing it — releasing would free budget for money that was
    // actually spent (used_usd never recorded it), letting later requests
    // overspend the cap. The stale-lease sweep reconciles the leftover lease.
    log?.error({ err }, "failed to record actual cost; retrying settlement once");
    try {
      await recordActualCost(pool, {
        projectId: aiRequest.projectId,
        userId: aiRequest.userId,
        feature: aiRequest.feature,
        actualCostUsd,
        // Post-top-up amount — releasing only the original reservation here
        // would strand the top-up portion in reserved_usd with the lease gone.
        estimatedCostUsd: settledReservedUsd,
        actualTokens,
        estimatedTokens: decision.estimatedTokens,
        caps: decision.reservationCaps,
        now,
        leaseId,
      });
    } catch (retryErr) {
      log?.error(
        { err: retryErr },
        "cost settlement retry failed; leaving the reservation for the lease-cleanup sweep to reconcile",
      );
    }
  }

  // Output safety: scan the completion for PII before returning it.
  let content = llm.content;
  try {
    const outputSafety = await safety.inspectOutput(content, decision.safetyPlan);
    if (outputSafety.action === "block") {
      return recordRejection(
        { pool, observability },
        {
          ...baseLog(aiRequest, decision, deps.policyMeta),
          resolvedModel: usedModel,
          decision: finalDecision,
          status: "safety_blocked",
          actualCostUsd,
          inputTokens: llm.inputTokens,
          outputTokens: llm.outputTokens,
          piiMasked,
          injectionBlocked,
          safetyFindings: outputSafety.findings,
          error: outputSafety.blockReason,
        },
        {
          ...baseObs(aiRequest, decision),
          decision: finalDecision,
          status: "safety_blocked",
          model: usedModel,
          reason: outputSafety.blockReason,
          actualCostUsd,
          piiMasked,
          injectionBlocked,
        },
        fail(403, "safety_blocked", {
          reason: outputSafety.blockReason,
          findings: outputSafety.findings,
        }),
      );
    }
    content = outputSafety.content;
    if (outputSafety.piiMasked) piiMasked = true;
  } catch (err) {
    if (err instanceof SafetyServiceError) {
      log?.error({ err }, "output safety backend failure");
      await logRequest(pool, {
        ...baseLog(aiRequest, decision, deps.policyMeta),
        resolvedModel: usedModel,
        decision: finalDecision,
        status: "failed",
        actualCostUsd,
        error: "output_safety_unavailable",
      });
      // The model call already ran and its cost is booked. Mark this 503
      // non-retryable so the idempotency layer caches it instead of releasing
      // the key — a retry would re-reserve, re-call the model, and double-charge.
      return {
        ...fail(503, "safety_unavailable", {}, "Safety service unavailable"),
        retryable: false,
      };
    }
    throw err;
  }

  const auditRequestId = await logRequest(pool, {
    ...baseLog(aiRequest, decision, deps.policyMeta),
    resolvedModel: usedModel,
    decision: finalDecision,
    status: "ok",
    actualCostUsd,
    inputTokens: llm.inputTokens,
    outputTokens: llm.outputTokens,
    piiMasked,
    injectionBlocked,
    traceTags: { ...decision.traceTags, policyDecision: finalDecision },
  });
  observability.recordChat({
    ...baseObs(aiRequest, decision),
    decision: finalDecision,
    status: "ok",
    model: usedModel,
    input: messages,
    output: content,
    inputTokens: llm.inputTokens,
    outputTokens: llm.outputTokens,
    actualCostUsd,
    piiMasked,
    injectionBlocked,
  });
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
    requestId: auditRequestId ?? "req_unknown",
  });
}
