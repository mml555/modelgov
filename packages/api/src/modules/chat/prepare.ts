import type { ResponseFormat } from "../../services/litellm";
import type { PolicyDecision, SafetyPlan, UsageSnapshot } from "@modelgov/policy-engine";
import type { ChatMessage } from "../../types";
import { SafetyServiceError } from "../../services/safety";
import { assertAiRequestsNotPaused } from "../emergency/service";
import type { BudgetNode, PathReservation } from "../budgets/repo";
import { bookSafetyIfAny, rejectPolicyBlock, type RejectionCtx } from "./lifecycle";
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
} from "./prep-hierarchical";
import { fail } from "./mapper";
import { buildGroundedMessages } from "./grounding";
import type { ChatFailure, ChatInput, ChatServiceDeps } from "./types";

export type BudgetHold =
  | {
      mode: "flat";
      usage: UsageSnapshot;
      leaseId?: string;
      reservedUsd: number;
      /** Wallet-lease hold id from the credit reserve (billing enabled only). */
      creditHoldId?: string;
    }
  | {
      mode: "hierarchical";
      nodes: BudgetNode[];
      held: PathReservation;
      reservedUsd: number;
      shardKey: string;
    };

export interface PreparedCall {
  aiRequest: import("@modelgov/policy-engine").AiRequest;
  decision: PolicyDecision;
  messages: ChatMessage[];
  now: Date;
  safetyCostUsd: number;
  piiMasked: boolean;
  injectionBlocked: boolean;
  temperature?: number;
  responseFormat?: ResponseFormat;
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
): Promise<{ costUsd: number; failure: ChatFailure | null }> {
  if (decision.safetyPlan.grounding !== "strict") return { costUsd: 0, failure: null };
  if (decision.safetyPlan.promptInjection !== "block") return { costUsd: 0, failure: null };
  if (!body.context || body.context.length === 0) return { costUsd: 0, failure: null };

  const ctxMessages: ChatMessage[] = body.context.map((c) => ({ role: "user", content: c }));
  const injOnlyPlan: SafetyPlan = { ...decision.safetyPlan, pii: "off", grounding: "off" };
  try {
    const res = await deps.safety.inspectInput(ctxMessages, injOnlyPlan);
    // The injection classifier is a billable provider call. Carry its cost back
    // so the caller books it through the same safety-cost conduit that reserve,
    // settlement, and every rejection path already account for — otherwise this
    // per-request spend leaks unaccounted on every grounded request.
    if (res.action === "block") {
      return {
        costUsd: res.safetyCostUsd,
        failure: fail(
          400,
          "grounding_context_rejected",
          { reason: "retrieved context failed prompt-injection screening" },
          "The provided grounding context was rejected by prompt-injection screening",
        ),
      };
    }
    return { costUsd: res.safetyCostUsd, failure: null };
  } catch (err) {
    if (err instanceof SafetyServiceError) {
      return { costUsd: 0, failure: fail(503, "safety_unavailable", {}, "Safety service unavailable") };
    }
    throw err;
  }
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
  const pause = await assertAiRequestsNotPaused(deps.pool, deps.policyMeta?.tenantId);
  if (pause.paused) {
    return fail(
      503,
      "ai_requests_paused",
      { reason: pause.reason ?? "emergency pause" },
      "AI requests are temporarily paused",
    );
  }

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
  const incurSafety = createIncurSafety(
    deps.pool,
    aiRequest,
    decision,
    now,
    deps.policyMeta?.tenantId,
    deps.billing,
  );

  if (decision.decision === "block") {
    return rejectPolicyBlock(rejection, decision);
  }

  if (stream) {
    const gate = streamSafetyGate(decision);
    if (gate) return gate;
  }

  const groundingFail = groundingContextRequired(decision, body);
  if (groundingFail) return groundingFail;
  // Grounding-context screening runs a billable injection classifier. Screen
  // after the stream gate so a (rejected) streaming request never pays for it,
  // and thread its cost through runInputSafety's safety-cost accounting so it is
  // reserved+settled on success and booked on any rejection.
  const ctxScreen = await screenGroundingContext(deps, decision, body);
  if (ctxScreen.failure) {
    await bookSafetyIfAny(incurSafety, ctxScreen.costUsd);
    return ctxScreen.failure;
  }

  const safetyOutcome = await runInputSafety(
    deps,
    body.messages,
    decision,
    rejection,
    incurSafety,
    stream ? "stream" : "chat",
    ctxScreen.costUsd,
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
      responseFormat: body.responseFormat,
      hold: {
        mode: "flat",
        usage,
        leaseId: reserved.leaseId,
        reservedUsd: reserved.reservedUsd,
        creditHoldId: reserved.creditHoldId,
      },
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
  const pause = await assertAiRequestsNotPaused(deps.pool, deps.policyMeta?.tenantId);
  if (pause.paused) {
    return fail(
      503,
      "ai_requests_paused",
      { reason: pause.reason ?? "emergency pause" },
      "AI requests are temporarily paused",
    );
  }

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

  // Screen grounding context after the path/incur are ready and after the stream
  // gate, so the billable classifier spend can be booked (via incurSafety) even
  // on the block path and is never paid for on a rejected streaming request.
  const ctxScreen = await screenGroundingContext(deps, decision, body);
  if (ctxScreen.failure) {
    await bookSafetyIfAny(incurSafety, ctxScreen.costUsd);
    return ctxScreen.failure;
  }

  const safetyOutcome = await runInputSafety(
    deps,
    body.messages,
    decision,
    rejection,
    incurSafety,
    stream ? "stream-hierarchical" : "hierarchical",
    ctxScreen.costUsd,
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
      responseFormat: body.responseFormat,
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
