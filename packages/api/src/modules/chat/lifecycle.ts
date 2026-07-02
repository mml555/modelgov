import {
  evaluateAiRequest,
  type AiGuardConfig,
  type AiRequest,
  type PolicyDecision,
  type UsageSnapshot,
} from "@ai-guard/policy-engine";
import type { Pool } from "pg";
import {
  LiteLLMClientError,
  ProviderError,
  type LiteLLMChatResult,
  type LiteLLMClient,
} from "../../services/litellm";
import type { ChatObservation, Observability } from "../../services/observability";
import type { SafetyResult } from "../../services/safety";
import { logRequest, type RequestLogRow } from "../usage/auditLogRepo";
import { budgetErrorContext, policyErrorFromDecision, policyErrorMessage } from "../../policyErrors";
import type { BudgetScope } from "../usage/repo";
import type { ChatMessage } from "../../types";
import { auditUnavailableFailure, baseLog, baseObs, fail, type PolicyMeta } from "./mapper";
import type { ChatFailure } from "./types";

// The chat request lifecycle has ONE set of failure semantics — reject with an
// audit trail, book classifier spend that already happened, release holds
// without losing spent money — implemented here once and composed by the three
// handlers (flat, hierarchical, stream). The handlers stay separate; what they
// share is this vocabulary, so a fix like "honor the fallback block" or "book
// safety spend on rejection" can never exist in one path and be missing from
// another.

/** Outcome of a budget reservation attempt (flat scope or node path). */
export interface ReserveOutcome {
  ok: boolean;
  failedScope?: BudgetScope;
  failedNodeId?: string;
  leaseId?: string;
}

export interface TopUpOutcome {
  ok: boolean;
  failedScope?: BudgetScope;
}

/**
 * Per-request budget operations. A strategy is stateful: `reserve` captures the
 * hold (lease / path reservation) that `release` and `settle` later operate on.
 * Flat injects `usage/repo`; hierarchical injects `budgets/repo` with the
 * request's node path and shard key. Consumed by the provider-execution helper
 * (Phase B); the rejection helpers below need only `incur`.
 */
export interface BudgetStrategy {
  reserve(estimateUsd: number): Promise<ReserveOutcome>;
  /** Book already-spent money (classifier cost). No cap check; no-op at <= 0. */
  incur(costUsd: number): Promise<void>;
  /** Free the current hold in full. */
  release(): Promise<void>;
  /** Book actual cost against the hold and drop the lease. */
  settle(actualUsd: number, actualTokens?: number): Promise<void>;
  /** Grow the hold for a pricier fallback. Flat only — hierarchical omits it
   * (a pricier fallback settles truthfully, overshooting the estimate). */
  topUp?(additionalUsd: number): Promise<TopUpOutcome>;
}

export type IncurFn = (costUsd: number) => Promise<void>;

/**
 * Budget operations needed during provider execution (after reserve). Flat
 * supplies `topUp`; hierarchical omits it.
 */
export interface ProviderBudgetCtx {
  incur: IncurFn;
  release: () => Promise<void>;
  topUp?: (additionalUsd: number) => Promise<TopUpOutcome>;
  getReservedUsd: () => number;
  setReservedUsd: (usd: number) => void;
}

export type ProviderCallDecision = "allow" | "degrade" | "fallback";

export type ProviderCallSuccess = {
  ok: true;
  llm: LiteLLMChatResult;
  usedModel: string;
  finalDecision: ProviderCallDecision;
  costBasis: number;
  reservedUsd: number;
};

export type ProviderCallOutcome = ProviderCallSuccess | { ok: false; failure: ChatFailure };

/** Everything a rejection needs to leave a correct audit trail. */
export interface RejectionCtx {
  pool: Pool;
  observability: Observability;
  aiRequest: AiRequest;
  policyMeta?: PolicyMeta & { requestedModelClass?: string };
}

/**
 * A chat request is rejected in several places (policy block, input-safety
 * block, budget-exceeded, provider error, output-safety block). Each must do
 * the same trio — append the audit log, emit the observability event, and
 * return the failure. Centralize it so a branch can't record one and forget
 * another, and so the sequence is single-sourced.
 */
export async function recordRejection(
  ctx: { pool: Pool; observability: Observability },
  logRow: RequestLogRow,
  observation: ChatObservation,
  result: ChatFailure,
  opts: { auditFailureRetryable?: boolean } = {},
): Promise<ChatFailure> {
  let auditRequestId: string;
  try {
    auditRequestId = await logRequest(ctx.pool, logRow);
  } catch {
    ctx.observability.recordChat({
      ...observation,
      status: "error",
      reason: "audit_unavailable",
    });
    return auditUnavailableFailure(opts.auditFailureRetryable ?? true);
  }
  ctx.observability.recordChat(observation);
  return {
    ...result,
    auditRequestId,
    details: { ...result.details, auditRequestId },
  };
}

/** Book classifier spend that already happened; no-op when there was none. */
export async function bookSafetyIfAny(incur: IncurFn, safetyCostUsd: number): Promise<void> {
  if (safetyCostUsd <= 0) return;
  await incur(safetyCostUsd);
}

/**
 * Free a hold whose model call never delivered, WITHOUT losing the classifier
 * spend inside it: book the safety portion as used first, then release the
 * full hold (net: safety spent, model freed). The ordering is deliberate — a
 * crash between the two leaves the hold for the lease sweep to reconcile,
 * whereas release-then-incur would lose the spend entirely.
 */
export async function releaseWithSafety(
  incur: IncurFn,
  release: () => Promise<void>,
  safetyCostUsd: number,
): Promise<void> {
  await bookSafetyIfAny(incur, safetyCostUsd);
  await release();
}

/**
 * Standard 403 policy_blocked rejection for a block decision — from the
 * initial evaluation or the forceFallback re-eval. Audits the block, emits
 * observability, and returns the stable error contract.
 *
 * `includeBudgetRemaining: false` is for hierarchical mode, where the flat
 * budget gates were evaluated against ZERO_USAGE — reporting their "remaining"
 * would claim full flat headroom while the node tree is the real authority.
 */
export async function rejectPolicyBlock(
  ctx: RejectionCtx,
  block: PolicyDecision,
  opts: { safetyCostUsd?: number; includeBudgetRemaining?: boolean } = {},
): Promise<ChatFailure> {
  const { safetyCostUsd = 0, includeBudgetRemaining = true } = opts;
  const policy = policyErrorFromDecision(block, {
    userId: ctx.aiRequest.userId,
    userType: ctx.aiRequest.userType,
    feature: ctx.aiRequest.feature,
  });
  if (!includeBudgetRemaining) delete policy.budgetRemaining;
  return recordRejection(
    ctx,
    {
      ...baseLog(ctx.aiRequest, block, ctx.policyMeta),
      status: "failed",
      error: block.reason,
      reasonCode: block.reasonCode,
      ...(safetyCostUsd > 0 ? { actualCostUsd: safetyCostUsd } : {}),
    },
    { ...baseObs(ctx.aiRequest, block), status: "blocked", reason: block.reason },
    fail(
      403,
      "policy_blocked",
      {
        reason: block.reason,
        reasonCode: block.reasonCode,
        ...(includeBudgetRemaining ? { budgetRemaining: block.budgetRemaining } : {}),
      },
      policyErrorMessage("policy_blocked", policy),
      policy,
    ),
    { auditFailureRetryable: safetyCostUsd <= 0 },
  );
}

/**
 * Standard 403 safety_blocked rejection: books the classifier spend (the scan
 * was a real provider call even though the request is blocked — booking never
 * gates), then audits and returns the failure.
 */
export async function rejectSafetyBlock(
  ctx: RejectionCtx,
  incur: IncurFn,
  args: {
    decision: PolicyDecision;
    safetyResult: Pick<SafetyResult, "findings" | "blockReason" | "piiMasked" | "injectionBlocked">;
    safetyCostUsd: number;
  },
): Promise<ChatFailure> {
  const { decision, safetyResult, safetyCostUsd } = args;
  await bookSafetyIfAny(incur, safetyCostUsd);
  return recordRejection(
    ctx,
    {
      ...baseLog(ctx.aiRequest, decision, ctx.policyMeta),
      status: "safety_blocked",
      piiMasked: safetyResult.piiMasked,
      injectionBlocked: safetyResult.injectionBlocked,
      safetyFindings: safetyResult.findings,
      error: safetyResult.blockReason,
      ...(safetyCostUsd > 0 ? { actualCostUsd: safetyCostUsd } : {}),
    },
    // NB: no `input` on the observation — on a safety block the input is
    // exactly the content that tripped the guard (PII / injection), so
    // exporting it to the observability backend would leak what we blocked.
    {
      ...baseObs(ctx.aiRequest, decision),
      status: "safety_blocked",
      reason: safetyResult.blockReason,
      piiMasked: safetyResult.piiMasked,
      injectionBlocked: safetyResult.injectionBlocked,
    },
    fail(403, "safety_blocked", {
      reason: safetyResult.blockReason,
      findings: safetyResult.findings,
    }),
    { auditFailureRetryable: safetyCostUsd <= 0 },
  );
}

/** Standard 403 budget_exceeded after a fallback top-up is rejected. */
export async function rejectTopUpBudgetExceeded(
  ctx: RejectionCtx,
  decision: PolicyDecision,
  args: { failedScope: BudgetScope; safetyCostUsd: number },
): Promise<ChatFailure> {
  const reason = `budget_exceeded:${args.failedScope}`;
  const policy = budgetErrorContext(
    args.failedScope,
    {
      userId: ctx.aiRequest.userId,
      userType: ctx.aiRequest.userType,
      feature: ctx.aiRequest.feature,
    },
    decision.budgetRemaining,
  );
  return recordRejection(
    ctx,
    {
      ...baseLog(ctx.aiRequest, decision, ctx.policyMeta),
      status: "failed",
      error: reason,
      reasonCode: policy.reasonCode,
      ...(args.safetyCostUsd > 0 ? { actualCostUsd: args.safetyCostUsd } : {}),
    },
    { ...baseObs(ctx.aiRequest, decision), status: "blocked", reason },
    fail(
      403,
      "budget_exceeded",
      {
        scope: args.failedScope,
        reasonCode: policy.reasonCode,
        budgetRemaining: decision.budgetRemaining,
      },
      policyErrorMessage("budget_exceeded", policy),
      policy,
    ),
    { auditFailureRetryable: args.safetyCostUsd <= 0 },
  );
}

/** Standard 502 provider failure after releaseWithSafety. */
export async function rejectProviderFailure(
  ctx: RejectionCtx,
  args: {
    decision: PolicyDecision;
    usedModel: string;
    finalDecision: ProviderCallDecision;
    safetyCostUsd: number;
    err: unknown;
  },
): Promise<ChatFailure> {
  const detail = (args.err as Error).message;
  const code =
    args.err instanceof LiteLLMClientError ? "upstream_rejected" : "provider_unavailable";
  const message =
    args.err instanceof LiteLLMClientError
      ? "Upstream rejected request"
      : "Provider unavailable";
  return recordRejection(
    ctx,
    {
      ...baseLog(ctx.aiRequest, args.decision, ctx.policyMeta),
      resolvedModel: args.usedModel,
      decision: args.finalDecision,
      status: "failed",
      error: detail,
      ...(args.safetyCostUsd > 0 ? { actualCostUsd: args.safetyCostUsd } : {}),
    },
    {
      ...baseObs(ctx.aiRequest, args.decision),
      decision: args.finalDecision,
      status: "error",
      reason: detail,
    },
    fail(502, code, {}, message),
    { auditFailureRetryable: args.safetyCostUsd <= 0 },
  );
}

/**
 * Primary provider call with optional fallback on `ProviderError`. The
 * `forceFallback` re-eval block check lives here exactly once — flat and
 * hierarchical compose this instead of copying nested try/catch.
 */
export async function executeProviderWithFallback(
  deps: {
    litellm: LiteLLMClient;
    config: AiGuardConfig;
    usage: UsageSnapshot;
    log?: { warn(obj: unknown, msg: string): void };
  },
  ctx: {
    aiRequest: AiRequest;
    decision: PolicyDecision;
    messages: ChatMessage[];
    temperature?: number;
    safetyCostUsd: number;
    rejection: RejectionCtx;
    includeBudgetRemaining?: boolean;
  },
  budget: ProviderBudgetCtx,
): Promise<ProviderCallOutcome> {
  let usedModel = ctx.decision.resolvedModel;
  let finalDecision = ctx.decision.decision as ProviderCallDecision;
  let costBasis = ctx.decision.estimatedCostUsd;

  try {
    try {
      const llm = await deps.litellm.chat({
        model: ctx.decision.resolvedModel,
        messages: ctx.messages,
        maxTokens: ctx.decision.maxOutputTokens,
        temperature: ctx.temperature,
      });
      return {
        ok: true,
        llm,
        usedModel,
        finalDecision,
        costBasis,
        reservedUsd: budget.getReservedUsd(),
      };
    } catch (err) {
      if (err instanceof ProviderError && ctx.decision.fallbackModel) {
        const fb = evaluateAiRequest({
          request: { ...ctx.aiRequest, forceFallback: true },
          config: deps.config,
          usage: deps.usage,
        });
        if (fb.decision === "block") {
          await releaseWithSafety(budget.incur, budget.release, ctx.safetyCostUsd);
          const failure = await rejectPolicyBlock(ctx.rejection, fb, {
            safetyCostUsd: ctx.safetyCostUsd,
            includeBudgetRemaining: ctx.includeBudgetRemaining ?? true,
          });
          return { ok: false, failure };
        }
        const fbReserve = fb.estimatedCostUsd + ctx.safetyCostUsd;
        if (fbReserve > budget.getReservedUsd() && budget.topUp) {
          const topUp = await budget.topUp(fbReserve - budget.getReservedUsd());
          if (!topUp.ok) {
            await releaseWithSafety(budget.incur, budget.release, ctx.safetyCostUsd);
            const failure = await rejectTopUpBudgetExceeded(ctx.rejection, ctx.decision, {
              failedScope: topUp.failedScope!,
              safetyCostUsd: ctx.safetyCostUsd,
            });
            return { ok: false, failure };
          }
          budget.setReservedUsd(fbReserve);
        }
        deps.log?.warn(
          { primary: ctx.decision.resolvedModel, fallback: fb.resolvedModel },
          "primary provider failed - routing to fallback",
        );
        usedModel = fb.resolvedModel;
        finalDecision = "fallback";
        costBasis = fb.estimatedCostUsd;
        const llm = await deps.litellm.chat({
          model: fb.resolvedModel,
          messages: ctx.messages,
          maxTokens: fb.maxOutputTokens,
          temperature: ctx.temperature,
        });
        return {
          ok: true,
          llm,
          usedModel,
          finalDecision,
          costBasis,
          reservedUsd: budget.getReservedUsd(),
        };
      }
      throw err;
    }
  } catch (err) {
    await releaseWithSafety(budget.incur, budget.release, ctx.safetyCostUsd);
    const failure = await rejectProviderFailure(ctx.rejection, {
      decision: ctx.decision,
      usedModel,
      finalDecision,
      safetyCostUsd: ctx.safetyCostUsd,
      err,
    });
    return { ok: false, failure };
  }
}
