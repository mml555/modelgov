import type { PolicyDecision, SafetyPlan, UsageSnapshot } from "@ai-guard/policy-engine";
import { SafetyServiceError } from "../../services/safety";
import { logRequest } from "../usage/auditLogRepo";
import { recordActualCost } from "../usage/repo";
import { settlePath, type BudgetNode, type PathReservation } from "../budgets/repo";
import {
  executeProviderWithFallback,
  recordRejection,
  rejectPolicyBlock,
  type RejectionCtx,
} from "./lifecycle";
import { createFlatProviderBudget, createHierarchicalProviderBudget } from "./providerBudget";
import {
  createIncurSafety,
  evaluateFlatPolicy,
  fireGlobalBudgetAlertIfNeeded,
  reserveFlatBudgetOrReject,
  runInputSafety,
} from "./prep";
import {
  auditPathPrecheckBlock,
  createHierarchicalIncurSafety,
  evaluateHierarchicalPolicy,
  isHonoredPolicyBlock,
  loadHierarchicalPath,
  rejectHonoredPolicyBlock,
  reserveHierarchicalOrReject,
  ZERO_USAGE,
} from "./prep-hierarchical";
import { auditUnavailableFailure, baseLog, baseObs, chatSuccessBody, fail } from "./mapper";
import { buildGroundedMessages, verifyGrounding } from "./grounding";
import type { ChatFailure, ChatInput, ChatResult, ChatServiceDeps } from "./types";
import type { ChatMessage } from "../../types";

export type BudgetHold =
  | { mode: "flat"; usage: UsageSnapshot; leaseId?: string; reservedUsd: number }
  | {
      mode: "hierarchical";
      nodes: BudgetNode[];
      held: PathReservation;
      reservedUsd: number;
      shardKey: string;
    };

export interface PreparedCall {
  aiRequest: import("@ai-guard/policy-engine").AiRequest;
  decision: PolicyDecision;
  messages: ChatMessage[];
  now: Date;
  safetyCostUsd: number;
  piiMasked: boolean;
  injectionBlocked: boolean;
  temperature?: number;
  hold: BudgetHold;
  rejection: RejectionCtx;
  /** Present when grounding=strict: the context to verify the answer against. */
  grounding?: { context: string[] };
}

function streamSafetyGate(decision: PolicyDecision): ChatFailure | null {
  if (decision.safetyPlan.pii !== "off") {
    return fail(
      400,
      "streaming_unsupported",
      { reason: "output PII protection is enabled for this feature; streaming would bypass it" },
      "Streaming is not supported when output PII protection is enabled",
    );
  }
  // Grounding verification needs the full completion to check citations, so it
  // is incompatible with token-by-token streaming.
  if (decision.safetyPlan.grounding === "strict") {
    return fail(
      400,
      "streaming_unsupported",
      { reason: "grounding is enabled for this feature; the answer must be verified before it is sent" },
      "Streaming is not supported when grounding is enabled",
    );
  }
  return null;
}

/**
 * A grounded feature MUST be called with a non-empty context block. Rejected
 * before budget is reserved so a misconfigured caller doesn't hold a lease.
 */
function groundingContextRequired(
  decision: PolicyDecision,
  body: ChatInput,
): ChatFailure | null {
  if (decision.safetyPlan.grounding !== "strict") return null;
  if (Array.isArray(body.context) && body.context.length > 0) return null;
  return fail(
    400,
    "grounding_context_required",
    { feature: body.feature },
    "This feature is grounded: it requires a non-empty `context` array to answer from",
  );
}

/** When grounding=strict, replace the messages with the gateway-owned grounded
 * prompt (built from the context); otherwise pass the messages through. */
function applyGrounding(
  decision: PolicyDecision,
  body: ChatInput,
  messages: ChatMessage[],
): { messages: ChatMessage[]; grounding?: { context: string[] } } {
  if (decision.safetyPlan.grounding === "strict" && body.context && body.context.length > 0) {
    return {
      messages: buildGroundedMessages(messages, body.context),
      grounding: { context: body.context },
    };
  }
  return { messages };
}

/**
 * Screen the retrieved grounding context for prompt injection. RAG context is
 * externally sourced, so a poisoned passage could otherwise hijack the grounded
 * answer (and cite itself past the verifier). Only runs when the feature already
 * blocks injection. PII is deliberately NOT masked here — verbatim citation
 * matching needs the raw text — so this screens for injection only.
 *
 * Note: the context is still sent to the provider un-masked by design (grounding
 * requires verbatim text), so ground only on trusted sources.
 */
async function screenGroundingContext(
  deps: ChatServiceDeps,
  decision: PolicyDecision,
  body: ChatInput,
): Promise<ChatFailure | null> {
  if (decision.safetyPlan.grounding !== "strict") return null;
  if (decision.safetyPlan.promptInjection !== "block") return null;
  if (!body.context || body.context.length === 0) return null;

  const ctxMessages: ChatMessage[] = body.context.map((c) => ({ role: "user", content: c }));
  const injOnlyPlan: SafetyPlan = { ...decision.safetyPlan, pii: "off", grounding: "off" };
  try {
    const res = await deps.safety.inspectInput(ctxMessages, injOnlyPlan);
    if (res.action === "block") {
      return fail(
        400,
        "grounding_context_rejected",
        { reason: "retrieved context failed prompt-injection screening" },
        "The provided grounding context was rejected by prompt-injection screening",
      );
    }
  } catch (err) {
    if (err instanceof SafetyServiceError) {
      return fail(503, "safety_unavailable", {}, "Safety service unavailable");
    }
    throw err;
  }
  return null;
}

/**
 * Unified pre-provider pipeline for flat and hierarchical budgets. Covers policy
 * evaluation, input safety, optional streaming gate, and budget reservation.
 */
export async function prepareChatCall(
  deps: ChatServiceDeps,
  body: ChatInput,
  opts: { leafNodeId?: string; stream?: boolean },
): Promise<ChatFailure | { ok: true; prepared: PreparedCall }> {
  if (opts.leafNodeId) {
    return prepareHierarchicalCall(deps, body, opts.leafNodeId, opts.stream ?? false);
  }
  return prepareFlatCall(deps, body, opts.stream ?? false);
}

async function prepareFlatCall(
  deps: ChatServiceDeps,
  body: ChatInput,
  stream: boolean,
): Promise<ChatFailure | { ok: true; prepared: PreparedCall }> {
  const evaluated = await evaluateFlatPolicy(deps, body);
  if (!evaluated.ok) return evaluated.failure;
  const { aiRequest, decision, usage, now } = evaluated;

  fireGlobalBudgetAlertIfNeeded(deps, usage, now);

  const rejection: RejectionCtx = {
    pool: deps.pool,
    observability: deps.observability,
    aiRequest,
    policyMeta: deps.policyMeta,
  };
  const incurSafety = createIncurSafety(deps.pool, aiRequest, decision, now, deps.policyMeta?.tenantId);

  if (decision.decision === "block") {
    return rejectPolicyBlock(rejection, decision);
  }

  const groundingFail = groundingContextRequired(decision, body);
  if (groundingFail) return groundingFail;
  const ctxScreenFail = await screenGroundingContext(deps, decision, body);
  if (ctxScreenFail) return ctxScreenFail;

  if (stream) {
    const gate = streamSafetyGate(decision);
    if (gate) return gate;
  }

  const safetyOutcome = await runInputSafety(
    deps,
    body.messages,
    decision,
    rejection,
    incurSafety,
    stream ? "stream" : "chat",
  );
  if ("status" in safetyOutcome) return safetyOutcome;

  const reserved = await reserveFlatBudgetOrReject(deps, {
    aiRequest,
    decision,
    safetyCostUsd: safetyOutcome.safetyCostUsd,
    now,
    rejection,
    incurSafety,
  });
  if (!reserved.ok) return reserved.failure;

  // Inject the grounded prompt AFTER safety so PII masking never rewrites the
  // trusted context (which would break verbatim citation checks).
  const grounded = applyGrounding(decision, body, safetyOutcome.messages);

  return {
    ok: true,
    prepared: {
      aiRequest,
      decision,
      messages: grounded.messages,
      now,
      safetyCostUsd: safetyOutcome.safetyCostUsd,
      piiMasked: safetyOutcome.piiMasked,
      injectionBlocked: safetyOutcome.injectionBlocked,
      temperature: body.temperature,
      hold: { mode: "flat", usage, leaseId: reserved.leaseId, reservedUsd: reserved.reservedUsd },
      rejection,
      grounding: grounded.grounding,
    },
  };
}

async function prepareHierarchicalCall(
  deps: ChatServiceDeps,
  body: ChatInput,
  leafNodeId: string,
  stream: boolean,
): Promise<ChatFailure | { ok: true; prepared: PreparedCall }> {
  const evaluated = await evaluateHierarchicalPolicy(deps, body);
  if (!evaluated.ok) return evaluated.failure;
  const { aiRequest, decision, now } = evaluated;

  const rejection: RejectionCtx = {
    pool: deps.pool,
    observability: deps.observability,
    aiRequest,
    policyMeta: deps.policyMeta,
  };
  if (isHonoredPolicyBlock(decision)) {
    return await rejectHonoredPolicyBlock(rejection, decision);
  }

  const groundingFail = groundingContextRequired(decision, body);
  if (groundingFail) return groundingFail;
  const ctxScreenFail = await screenGroundingContext(deps, decision, body);
  if (ctxScreenFail) return ctxScreenFail;

  const path = await loadHierarchicalPath(deps.pool, leafNodeId, decision, now, deps.policyMeta?.tenantId);
  if ("status" in path) return path;
  if (!path.ok) {
    return auditPathPrecheckBlock(deps, aiRequest, decision, path.reason, path.failedNodeId);
  }

  const shardKey = body.userId;
  const incurSafety = createHierarchicalIncurSafety(deps.pool, path.nodes, now, shardKey);

  if (stream) {
    const gate = streamSafetyGate(decision);
    if (gate) return gate;
  }

  const safetyOutcome = await runInputSafety(
    deps,
    body.messages,
    decision,
    rejection,
    incurSafety,
    stream ? "stream-hierarchical" : "hierarchical",
  );
  if ("status" in safetyOutcome) return safetyOutcome;

  const reserved = await reserveHierarchicalOrReject(deps, {
    aiRequest,
    decision,
    nodes: path.nodes,
    safetyCostUsd: safetyOutcome.safetyCostUsd,
    now,
    shardKey,
    rejection,
    incurSafety,
  });
  if (!reserved.ok) return reserved.failure;

  const grounded = applyGrounding(decision, body, safetyOutcome.messages);

  return {
    ok: true,
    prepared: {
      aiRequest,
      decision,
      messages: grounded.messages,
      now,
      safetyCostUsd: safetyOutcome.safetyCostUsd,
      piiMasked: safetyOutcome.piiMasked,
      injectionBlocked: safetyOutcome.injectionBlocked,
      temperature: body.temperature,
      hold: {
        mode: "hierarchical",
        nodes: reserved.nodes,
        held: reserved.held,
        reservedUsd: reserved.reservedUsd,
        shardKey: reserved.shardKey,
      },
      rejection,
      grounding: grounded.grounding,
    },
  };
}

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

  if (hold.mode === "flat") {
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
        leaseId: hold.leaseId,
        tenantId: deps.policyMeta?.tenantId,
      });
      if (actualCostUsd > settledReservedUsd) {
        log?.warn(
          { reservedUsd: settledReservedUsd, actualCostUsd, model: usedModel },
          "actual cost exceeded the reserved estimate — budget cap may be overshot",
        );
      }
    } catch (err) {
      log?.error({ err }, "failed to record actual cost; retrying settlement once");
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
          leaseId: hold.leaseId,
          tenantId: deps.policyMeta?.tenantId,
        });
      } catch (retryErr) {
        log?.error(
          { err: retryErr },
          "cost settlement retry failed; leaving the reservation for the lease-cleanup sweep to reconcile",
        );
      }
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
    const verdict = verifyGrounding(content, prepared.grounding.context);
    content = verdict.answer;
    grounded = verdict.grounded;
    if (!grounded) {
      log?.warn(
        { feature: aiRequest.feature, verifiedQuotes: verdict.verifiedQuotes },
        "grounding verification failed — answer replaced with refusal",
      );
    }
  }

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
        { auditFailureRetryable: false },
      );
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
        return auditUnavailableFailure(false);
      }
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
      ...(grounded === undefined ? {} : { reasonCode: grounded ? "grounded" : "grounding_refused" }),
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
    return auditUnavailableFailure(false);
  }
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
    requestId: auditRequestId,
  });
}
