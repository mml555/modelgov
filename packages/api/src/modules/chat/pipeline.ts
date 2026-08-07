import { SafetyServiceError, type OutputSafetyResult } from "../../services/safety";
import { logRequest } from "../usage/auditLogRepo";
import { settleActualCostWithRetry } from "../usage/repo";
import { settlePath } from "../budgets/repo";
import {
  executeProviderWithFallback,
  recordRejection,
  settleBillingCredits,
} from "./lifecycle";
import { createFlatProviderBudget, createHierarchicalProviderBudget } from "./providerBudget";
import { ZERO_USAGE } from "./prep-hierarchical";
import { auditUnavailableFailure, baseLog, baseObs, chatSuccessBody, fail } from "./mapper";
import { verifyGrounding } from "./grounding";
import { maskStructuredOutput } from "./structuredOutput";
import type { ChatResult, ChatServiceDeps } from "./types";
import type { PreparedCall } from "./prepare";

/** Provider execution, settlement, output safety, and success envelope. */
export async function executeSyncChat(
  deps: ChatServiceDeps,
  prepared: PreparedCall,
): Promise<ChatResult> {
  const { config, pool, litellm, safety, observability, log } = deps;
  const { aiRequest, decision, messages, now, safetyCostUsd, hold, rejection } = prepared;
  let { piiMasked } = prepared;
  const { injectionBlocked } = prepared;

  const providerBudget =
    hold.mode === "flat"
      ? createFlatProviderBudget({
          pool,
          aiRequest,
          decision,
          now,
          leaseId: hold.leaseId,
          initialReservedUsd: hold.reservedUsd,
          tenantId: deps.policyMeta?.tenantId,
          billing: deps.billing,
          skipInternalBudget:
            deps.billing?.enabled === true && deps.billing.mode === "credits_only",
          safetyCostUsd,
          creditHoldId: hold.creditHoldId,
        })
      : createHierarchicalProviderBudget({
          pool,
          nodes: hold.nodes,
          now,
          shardKey: hold.shardKey,
          held: hold.held,
          initialReservedUsd: hold.reservedUsd,
        });

  const flatUsage = hold.mode === "flat" ? hold.usage : ZERO_USAGE;
  const provider = await executeProviderWithFallback(
    { litellm, config, usage: flatUsage, log },
    {
      aiRequest,
      decision,
      messages,
      temperature: prepared.temperature,
      responseFormat: prepared.responseFormat,
      safetyCostUsd,
      rejection,
      includeBudgetRemaining: hold.mode === "hierarchical" ? false : undefined,
    },
    providerBudget,
  );
  if (!provider.ok) return provider.failure;

  const { llm, usedModel, finalDecision, costBasis } = provider;
  const settledReservedUsd = provider.reservedUsd;
  const actualCostUsd = (llm.actualCostUsd ?? costBasis) + safetyCostUsd;
  const actualTokens = (llm.inputTokens ?? 0) + (llm.outputTokens ?? 0);

  // The ONE billing-settlement exit point for this function. The model call ran
  // and its cost is real, so every return below this line — success, blocked
  // response, audit/safety failure — must pass through settleBilling exactly
  // once, or the credit reservation leaks. Metering is keyed by audit request
  // id; exits with no audit row pass "" and skip the meter (see lifecycle.ts).
  const settleBilling = (requestId: string) =>
    settleBillingCredits(deps.billing, log, {
      tenantId: deps.policyMeta?.tenantId ?? "",
      userId: aiRequest.userId,
      feature: aiRequest.feature,
      reservedUsd: settledReservedUsd,
      actualCostUsd,
      requestId,
      creditHoldId: hold.mode === "flat" ? hold.creditHoldId : undefined,
    });

  const skipInternalBudget =
    deps.billing?.enabled === true && deps.billing.mode === "credits_only";

  if (skipInternalBudget) {
    // credits_only billing: skip the internal budget ledger entirely — billing
    // settles the spend via credits below (settleCredits / recordMeter).
  } else if (hold.mode === "flat") {
    await settleActualCostWithRetry(
      pool,
      {
        projectId: aiRequest.projectId,
        userId: aiRequest.userId,
        feature: aiRequest.feature,
        actualCostUsd,
        estimatedCostUsd: settledReservedUsd,
        actualTokens,
        estimatedTokens: decision.estimatedTokens,
        caps: decision.reservationCaps,
        now,
        leaseId: hold.leaseId,
        tenantId: deps.policyMeta?.tenantId,
      },
      log,
    );
    if (actualCostUsd > settledReservedUsd) {
      log?.warn(
        { reservedUsd: settledReservedUsd, actualCostUsd, model: usedModel },
        "actual cost exceeded the reserved estimate — budget cap may be overshot",
      );
    }
  } else {
    try {
      await settlePath(pool, hold.held, actualCostUsd);
    } catch (err) {
      log?.error({ err }, "hierarchical settle failed; node lease sweep will reconcile");
    }
  }

  let content = llm.content;

  // Grounding verification (grounding=strict) runs on the RAW model output —
  // BEFORE any PII masking, which would otherwise mangle the structured JSON /
  // citations and make every grounded answer fail verification. It extracts the
  // human-facing answer (or a refusal); output safety then masks PII in that.
  let grounded: boolean | undefined;
  if (prepared.grounding) {
    const verdict = verifyGrounding(
      content,
      prepared.grounding.context,
      prepared.grounding.options,
    );
    content = verdict.answer;
    grounded = verdict.grounded;
    if (!grounded) {
      log?.warn(
        { feature: aiRequest.feature, verifiedQuotes: verdict.verifiedQuotes },
        "grounding verification failed — answer replaced with refusal",
      );
    }
  }

  // Structured responses are masked per JSON VALUE, not as a text pass over the
  // serialized blob — see structuredOutput.ts. `structured` is false when the
  // model ignored responseFormat and returned prose, in which case we fall
  // through to the ordinary path rather than skip output safety.
  let structuredMasked = false;
  try {
    let outputSafety: OutputSafetyResult;
    if (prepared.responseFormat) {
      const s = await maskStructuredOutput(safety, content, decision.safetyPlan);
      if (s.structured) {
        structuredMasked = s.masked;
        outputSafety = {
          action: s.action,
          content: s.content,
          piiMasked: s.masked,
          findings: s.findings,
          ...(s.blockReason ? { blockReason: s.blockReason } : {}),
        };
      } else {
        outputSafety = await safety.inspectOutput(content, decision.safetyPlan);
      }
    } else {
      outputSafety = await safety.inspectOutput(content, decision.safetyPlan);
    }
    if (outputSafety.action === "block") {
      const blocked = await recordRejection(
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
        { auditFailureRetryable: false },
      );
      // The response is blocked but the model call ran — its cost is real.
      await settleBilling(blocked.auditRequestId ?? "");
      return blocked;
    }
    content = outputSafety.content;
    if (outputSafety.piiMasked) piiMasked = true;
  } catch (err) {
    if (err instanceof SafetyServiceError) {
      log?.error({ err }, "output safety backend failure");
      try {
        await logRequest(pool, {
          ...baseLog(aiRequest, decision, deps.policyMeta),
          resolvedModel: usedModel,
          decision: finalDecision,
          status: "failed",
          actualCostUsd,
          error: "output_safety_unavailable",
        });
      } catch {
        observability.recordChat({
          ...baseObs(aiRequest, decision),
          decision: finalDecision,
          status: "error",
          model: usedModel,
          reason: "audit_unavailable",
          actualCostUsd,
          piiMasked,
          injectionBlocked,
        });
        await settleBilling("");
        return auditUnavailableFailure(false);
      }
      // Output safety is down but the model call ran — settle, meter skipped.
      await settleBilling("");
      return {
        ...fail(503, "safety_unavailable", {}, "Safety service unavailable"),
        retryable: false,
      };
    }
    throw err;
  }

  let auditRequestId: string;
  try {
    auditRequestId = await logRequest(pool, {
      ...baseLog(aiRequest, decision, deps.policyMeta),
      resolvedModel: usedModel,
      decision: finalDecision,
      status: "ok",
      actualCostUsd,
      inputTokens: llm.inputTokens,
      outputTokens: llm.outputTokens,
      piiMasked,
      injectionBlocked,
      // Grounding's verdict wins the single reasonCode slot when both apply —
      // a refused answer is the more consequential fact. structured_masked is
      // the /chat analogue of the documents path's structured_withheld.
      ...(grounded !== undefined
        ? { reasonCode: grounded ? "grounded" : "grounding_refused" }
        : structuredMasked
          ? { reasonCode: "structured_masked" as const }
          : {}),
      traceTags: { ...decision.traceTags, policyDecision: finalDecision },
    });
  } catch {
    observability.recordChat({
      ...baseObs(aiRequest, decision),
      decision: finalDecision,
      status: "error",
      model: usedModel,
      reason: "audit_unavailable",
      inputTokens: llm.inputTokens,
      outputTokens: llm.outputTokens,
      actualCostUsd,
      piiMasked,
      injectionBlocked,
    });
    await settleBilling("");
    return auditUnavailableFailure(false);
  }

  await settleBilling(auditRequestId);

  // For grounded requests the gateway prepended a system message carrying the
  // (deliberately un-masked) retrieved context; don't ship that to the
  // observability provider — log only the caller's messages.
  const observedInput = prepared.grounding ? messages.slice(1) : messages;
  observability.recordChat({
    ...baseObs(aiRequest, decision),
    decision: finalDecision,
    status: "ok",
    model: usedModel,
    input: observedInput,
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
    // Hierarchical: the node tree is the authority; a flat "remaining" computed
    // against ZERO_USAGE would falsely claim full headroom.
    budgetRemaining: hold.mode === "hierarchical" ? null : decision.budgetRemaining,
    piiMasked,
    injectionBlocked,
    grounded,
    // Only for responseFormat requests; undefined elsewhere so the field is
    // absent rather than a misleading `false` on every prose response.
    ...(prepared.responseFormat ? { structuredMasked } : {}),
    requestId: auditRequestId,
  });
}
