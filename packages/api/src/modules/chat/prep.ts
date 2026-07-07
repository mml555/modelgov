import {
  DEFAULT_INPUT_TOKENS,
  evaluateAiRequest,
  PolicyConfigError,
  type ModelgovConfig,
  type AiRequest,
  type PolicyDecision,
  type UsageSnapshot,
} from "@modelgov/policy-engine";
import { acquireCreditHold } from "../billing/reserve";
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

// ~4 chars/token is the standard rough proxy for OpenAI-family tokenizers.
// Image parts have no text but cost input tokens at the provider; count each at
// a conservative floor so a vision request can't under-reserve.
const CHARS_PER_TOKEN = 4;
const IMAGE_INPUT_TOKENS = 1000;

/**
 * Server-side floor on input tokens, computed from the ACTUAL request content.
 * The caller-supplied `inputTokensEstimate` is advisory and untrusted: a client
 * could send a 100k-token prompt while declaring `inputTokensEstimate: 1`, which
 * would size the budget reservation (and the disconnect-settle input charge) at
 * one token and let the request run essentially free. We take the max of the
 * declared estimate and this content-derived floor so the reservation can never
 * be smaller than the prompt actually warrants.
 *
 * `context` (grounding passages) is counted too: for a `grounding: strict`
 * feature `applyGrounding` prepends it to the provider prompt, so a large
 * `context` with a tiny `inputTokensEstimate` would otherwise re-open the
 * under-reservation. Counting it unconditionally is safe — the estimate only
 * gates the budget check (worst-case by design); actual cost is settled from
 * real provider usage.
 */
export function estimateInputTokensFromMessages(
  messages: ChatInput["messages"],
  context?: ChatInput["context"],
): number {
  let chars = 0;
  let images = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      chars += message.content.length;
    } else {
      for (const part of message.content) {
        if (part.type === "text") chars += part.text.length;
        else images += 1;
      }
    }
  }
  for (const passage of context ?? []) chars += passage.length;
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_INPUT_TOKENS;
}

/** Map a validated chat body + config to the engine's request shape. */
export function buildAiRequest(body: ChatInput, config: ModelgovConfig): AiRequest {
  // Baseline is the client's declared estimate, or the conservative default when
  // omitted (preserving the prior behavior for short prompts / token caps). The
  // content-derived floor then raises it so a client can't UNDER-declare a large
  // prompt (see estimateInputTokensFromMessages). Net effect: the estimate only
  // ever moves UP from the old value, never down — no under-reservation.
  const baseline = body.inputTokensEstimate ?? DEFAULT_INPUT_TOKENS;
  const serverFloor = estimateInputTokensFromMessages(body.messages, body.context);
  return {
    projectId: body.projectId ?? config.project.name,
    environment: body.environment ?? config.project.environment,
    userId: body.userId,
    userType: body.userType,
    feature: body.feature,
    requestedModelClass: body.modelClass,
    inputTokensEstimate: Math.max(baseline, serverFloor),
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

/**
 * Book classifier spend incurred on a rejection path (safety block, budget
 * failure, grounding-context screening). Routes to whichever ledger is
 * authoritative for the deployment:
 *  - credit wallet (credits/hybrid): the classifier already ran and there is no
 *    reservation on the rejection path, so debit it directly (settleCredits with
 *    reservedUsd 0). Without this, credits_only would never charge the wallet for
 *    it and the spend would leak.
 *  - internal budget_counters: the source of truth unless credits_only, where
 *    the wallet is the sole ledger and an UPSERT here would pollute unused rows.
 */
export function createIncurSafety(
  pool: ChatServiceDeps["pool"],
  aiRequest: AiRequest,
  decision: PolicyDecision,
  now: Date,
  tenantId?: string,
  billing?: ChatServiceDeps["billing"],
): IncurFn {
  const creditsOnly = billing?.enabled === true && billing.mode === "credits_only";
  return async (costUsd) => {
    if (costUsd <= 0) return;
    if (billing?.usesCredits()) {
      await billing.settleCredits(tenantId ?? "", aiRequest.userId, 0, costUsd);
    }
    if (!creditsOnly) {
      await recordIncurredCost(pool, {
        projectId: aiRequest.projectId,
        userId: aiRequest.userId,
        feature: aiRequest.feature,
        costUsd,
        caps: decision.reservationCaps,
        now,
        tenantId,
      });
    }
  };
}

export interface InputSafetyOutcome {
  messages: ChatMessage[];
  piiMasked: boolean;
  injectionBlocked: boolean;
  safetyCostUsd: number;
}

/**
 * Run input safety (PII + injection). Returns a failure or the (possibly masked)
 * messages. `priorSafetyCostUsd` folds in classifier spend already incurred
 * upstream (e.g. grounding-context screening) so it is carried through the same
 * accounting: added to the returned total (reserved + settled on success) and
 * booked on the safety-block path so it is never lost.
 */
export async function runInputSafety(
  deps: ChatServiceDeps,
  messages: ChatInput["messages"],
  decision: PolicyDecision,
  rejection: RejectionCtx,
  incurSafety: IncurFn,
  logContext = "chat",
  priorSafetyCostUsd = 0,
): Promise<InputSafetyOutcome | ChatFailure> {
  let working = messages;
  let piiMasked = false;
  let injectionBlocked = false;
  let safetyCostUsd = priorSafetyCostUsd;
  try {
    const safetyResult = await deps.safety.inspectInput(working, decision.safetyPlan);
    working = safetyResult.messages;
    piiMasked = safetyResult.piiMasked;
    injectionBlocked = safetyResult.injectionBlocked;
    safetyCostUsd += safetyResult.safetyCostUsd;
    if (safetyResult.action === "block") {
      return rejectSafetyBlock(rejection, incurSafety, {
        decision,
        safetyResult,
        safetyCostUsd,
      });
    }
  } catch (err) {
    if (err instanceof SafetyServiceError) {
      // Fail closed on a safety outage, but don't lose classifier spend already
      // incurred upstream (grounding screen) — book it before returning.
      await bookSafetyIfAny(incurSafety, priorSafetyCostUsd);
      deps.log?.error({ err }, `safety backend failure (${logContext})`);
      return fail(503, "safety_unavailable", {}, "Safety service unavailable");
    }
    throw err;
  }
  return { messages: working, piiMasked, injectionBlocked, safetyCostUsd };
}

export type FlatReserveResult =
  | { ok: true; leaseId?: string; reservedUsd: number; creditHoldId?: string }
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
  const totalEstimate = decision.estimatedCostUsd + safetyCostUsd;
  const tenantId = deps.policyMeta?.tenantId ?? "";
  const billing = deps.billing;
  const skipInternalReserve = billing?.enabled && billing.mode === "credits_only";

  // Reserve prepaid credits under a per-request hold (groups the base reserve and
  // any fallback top-ups so a crash between reserve and settle is reconciled by
  // the lease sweep). Shared with the embeddings path via acquireCreditHold so
  // the reserve/gate/hold-id step can't drift. reserveCredits checks the balance
  // atomically inside its UPDATE; the balance is read only on failure, for 402.
  const hold = await acquireCreditHold(billing, tenantId, aiRequest.userId, totalEstimate);
  if (!hold.ok) {
    await bookSafetyIfAny(incurSafety, safetyCostUsd);
    return {
      ok: false,
      failure: await recordRejection(
        rejection,
        {
          ...baseLog(aiRequest, decision, deps.policyMeta),
          status: "failed",
          error: "insufficient_credits",
          reasonCode: "insufficient_credits",
          ...(safetyCostUsd > 0 ? { actualCostUsd: safetyCostUsd } : {}),
        },
        baseObs(aiRequest, decision),
        fail(402, "insufficient_credits", {
          reasonCode: "insufficient_credits",
          creditsAvailableUsd: hold.availableUsd,
          estimatedCostUsd: totalEstimate,
        }, "Insufficient credits"),
      ),
    };
  }
  const creditHoldId = hold.holdId;
  const reservedCredits = hold.reservedUsd;

  if (skipInternalReserve) {
    return { ok: true, reservedUsd: reservedCredits, creditHoldId };
  }

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
    // Release even when reservedCredits is 0: a hold with a zero-amount lease
    // still needs its lease deleted, or it lingers until the stale-lease sweep.
    if (billing && (reservedCredits > 0 || creditHoldId)) {
      await billing.releaseCredits(tenantId, aiRequest.userId, reservedCredits, creditHoldId);
    }
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
  // skipInternalReserve already early-returned above; reaching here means the
  // internal reservation is the authoritative amount.
  return {
    ok: true,
    leaseId: reservation.leaseId,
    reservedUsd: decision.estimatedCostUsd + safetyCostUsd,
    creditHoldId,
  };
}
