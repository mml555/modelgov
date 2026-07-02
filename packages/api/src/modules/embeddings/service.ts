import {
  evaluateAiRequest,
  PolicyConfigError,
  providerOf,
  type AiGuardConfig,
  type AiRequest,
  type BudgetRemaining,
  type PolicyDecision,
} from "@ai-guard/policy-engine";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import {
  loadUsageSnapshot,
  recordActualCost,
  reserveBudget,
  topUpBudget,
} from "../usage/repo";
import { logRequest } from "../usage/auditLogRepo";
import { baseLog, baseObs, remainingAfter } from "../chat/mapper";
import type { Observability } from "../../services/observability";
import {
  LiteLLMClientError,
  ProviderError,
  type LiteLLMClient,
} from "../../services/litellm";
import type { EmbeddingsInput } from "./schemas";

export interface EmbeddingsDeps {
  config: AiGuardConfig;
  pool: Pool;
  litellm: LiteLLMClient;
  /** Optional tracing/metrics sink. When set, every embeddings outcome is
   * recorded the same way chat outcomes are (spend + decision visibility). */
  observability?: Observability;
  policyMeta?: { configHash?: string; policyVersion?: string; tenantId?: string };
  log?: FastifyBaseLogger;
}

export interface EmbeddingsSuccessBody {
  embeddings: number[][];
  model: string;
  provider: string;
  decision: "allow" | "degrade" | "fallback";
  reason?: string;
  usage: { inputTokens: number | null };
  cost: { estimatedUsd: number; actualUsd: number };
  budgetRemaining: BudgetRemaining | null;
  requestId: string;
}

export type EmbeddingsResult =
  | { ok: true; body: EmbeddingsSuccessBody }
  | {
      ok: false;
      status: number;
      code: string;
      details: Record<string, unknown>;
      message?: string;
      auditRequestId?: string;
      retryable?: boolean;
    };

/** ~4 chars/token — used only when the caller supplies no estimate, so the
 * pre-call budget gate reflects real input size (the actual cost reconciles it). */
function estimateTokensFromText(texts: string[]): number {
  const chars = texts.reduce((sum, t) => sum + t.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Governed embeddings: same policy/budget/audit spine as chat, but a single
 * OpenAI-compatible /embeddings call (no output safety — there's no text to
 * screen — and no injection classifier). Every call declares its feature and
 * user type, is checked before the provider runs, reserves budget, settles the
 * real cost, and lands one audit row.
 */
export async function handleEmbeddings(
  deps: EmbeddingsDeps,
  input: EmbeddingsInput,
): Promise<EmbeddingsResult> {
  if (!deps.litellm.embed) {
    return {
      ok: false,
      status: 501,
      code: "not_implemented",
      details: {},
      message: "Embeddings are not supported by this deployment",
    };
  }

  const { config, pool } = deps;
  const tenantId = deps.policyMeta?.tenantId;
  const texts = Array.isArray(input.input) ? input.input : [input.input];
  const now = new Date();

  const aiRequest: AiRequest = {
    projectId: input.projectId ?? config.project.name,
    environment: input.environment ?? config.project.environment,
    userId: input.userId,
    userType: input.userType,
    feature: input.feature,
    requestedModelClass: input.modelClass,
    inputTokensEstimate: input.inputTokensEstimate ?? estimateTokensFromText(texts),
    // Embeddings produce no completion — reserve zero output tokens so the
    // worst-case estimate doesn't add the feature's maxOutputTokens (which would
    // over-book budget and spuriously trip a token/USD cap).
    outputTokensEstimate: 0,
    metadata: input.metadata,
  };

  const usage = await loadUsageSnapshot(pool, {
    projectId: aiRequest.projectId,
    userId: aiRequest.userId,
    feature: aiRequest.feature,
    now,
    tenantId,
  });

  let decision: PolicyDecision;
  try {
    decision = evaluateAiRequest({ request: aiRequest, config, usage });
  } catch (err) {
    if (err instanceof PolicyConfigError) {
      return { ok: false, status: 400, code: err.code, details: { detail: err.message }, message: err.message };
    }
    throw err;
  }

  const rowBase = baseLog(aiRequest, decision, deps.policyMeta);

  // ── Policy block (over budget / not permitted) — audit and reject, no spend ──
  if (decision.decision === "block") {
    const error = decision.reasonCode ?? "policy_blocked";
    const auditRequestId = await tryLog(deps, { ...rowBase, status: "failed", error });
    deps.observability?.recordChat({
      ...baseObs(aiRequest, decision),
      status: "blocked",
      reason: decision.reason,
    });
    return {
      ok: false,
      status: 403,
      code: "policy_blocked",
      details: {
        reasonCode: decision.reasonCode,
        reason: decision.reason,
        budgetRemaining: decision.budgetRemaining,
      },
      message: decision.reason ?? "Request blocked by policy",
      auditRequestId,
    };
  }

  // ── Reserve budget (row-locked) — a concurrent request may have consumed it ──
  const reservation = await reserveBudget(pool, {
    projectId: aiRequest.projectId,
    userId: aiRequest.userId,
    feature: aiRequest.feature,
    estimatedCostUsd: decision.estimatedCostUsd,
    estimatedTokens: decision.estimatedTokens,
    caps: decision.reservationCaps,
    now,
    tenantId,
  });
  if (!reservation.ok) {
    const auditRequestId = await tryLog(deps, {
      ...rowBase,
      status: "failed",
      error: `budget_exceeded:${reservation.failedScope}`,
    });
    deps.observability?.recordChat({
      ...baseObs(aiRequest, decision),
      status: "blocked",
      reason: `budget_exceeded:${reservation.failedScope}`,
    });
    return {
      ok: false,
      status: 403,
      code: "budget_exceeded",
      details: { scope: reservation.failedScope, budgetRemaining: decision.budgetRemaining },
      message: "Budget exceeded",
      auditRequestId,
    };
  }
  const leaseId = reservation.leaseId;
  // May grow if a pricier fallback tops up the hold (see the fallback path).
  let reservedUsd = decision.estimatedCostUsd;

  // Release a reservation without booking spend (provider failure path).
  const releaseHold = async (): Promise<void> => {
    try {
      await recordActualCost(pool, {
        projectId: aiRequest.projectId,
        userId: aiRequest.userId,
        feature: aiRequest.feature,
        actualCostUsd: 0,
        estimatedCostUsd: reservedUsd,
        actualTokens: 0,
        estimatedTokens: decision.estimatedTokens,
        caps: decision.reservationCaps,
        now,
        leaseId,
        tenantId,
      });
    } catch (err) {
      deps.log?.error({ err }, "failed to release embeddings reservation; lease sweep will reconcile");
    }
  };

  // ── Provider call (single fallback on a provider-side failure) ──────────────
  let model = decision.resolvedModel;
  let usedFallback = false;
  let result: Awaited<ReturnType<NonNullable<LiteLLMClient["embed"]>>>;
  try {
    result = await deps.litellm.embed({ model, input: texts });
  } catch (err) {
    if (err instanceof ProviderError && decision.fallbackModel) {
      // Re-evaluate with forceFallback so the fallback model/provider is re-run
      // through the data-sensitivity gate (mirrors the chat pipeline) — a fallback
      // must not route restricted data to an unapproved provider.
      const fb = evaluateAiRequest({ request: { ...aiRequest, forceFallback: true }, config, usage });
      if (fb.decision === "block") {
        await releaseHold();
        const auditRequestId = await tryLog(deps, {
          ...rowBase,
          resolvedModel: fb.resolvedModel,
          status: "failed",
          error: fb.reasonCode ?? "policy_blocked",
        });
        return {
          ok: false,
          status: 403,
          code: "policy_blocked",
          details: { reasonCode: fb.reasonCode, reason: fb.reason },
          message: fb.reason ?? "Fallback blocked by policy",
          auditRequestId,
        };
      }
      // Grow the hold if the fallback estimate is pricier than the primary
      // reservation, and reject if that top-up breaches a cap — otherwise a
      // costlier fallback would silently overshoot the budget (mirrors chat's
      // executeProviderWithFallback top-up).
      if (fb.estimatedCostUsd > reservedUsd) {
        const topUp = await topUpBudget(pool, {
          projectId: aiRequest.projectId,
          userId: aiRequest.userId,
          feature: aiRequest.feature,
          additionalCostUsd: fb.estimatedCostUsd - reservedUsd,
          caps: decision.reservationCaps,
          now,
          leaseId,
          tenantId,
        });
        if (!topUp.ok) {
          await releaseHold();
          const auditRequestId = await tryLog(deps, {
            ...rowBase,
            resolvedModel: fb.resolvedModel,
            status: "failed",
            error: `budget_exceeded:${topUp.failedScope}`,
          });
          return {
            ok: false,
            status: 403,
            code: "budget_exceeded",
            details: { scope: topUp.failedScope, budgetRemaining: decision.budgetRemaining },
            message: "Budget exceeded",
            auditRequestId,
          };
        }
        reservedUsd = fb.estimatedCostUsd;
      }
      try {
        model = fb.resolvedModel;
        usedFallback = true;
        result = await deps.litellm.embed({ model, input: texts });
      } catch (fallbackErr) {
        return providerFailure(deps, releaseHold, rowBase, model, fallbackErr, { aiRequest, decision });
      }
    } else {
      return providerFailure(deps, releaseHold, rowBase, model, err, { aiRequest, decision });
    }
  }

  // ── Settle real cost against the reservation ────────────────────────────────
  const actualCostUsd = result.actualCostUsd ?? reservedUsd;
  const actualTokens = result.inputTokens ?? 0;
  const settleArgs = {
    projectId: aiRequest.projectId,
    userId: aiRequest.userId,
    feature: aiRequest.feature,
    actualCostUsd,
    estimatedCostUsd: reservedUsd,
    actualTokens,
    estimatedTokens: decision.estimatedTokens,
    caps: decision.reservationCaps,
    now,
    leaseId,
    tenantId,
  };
  try {
    await recordActualCost(pool, settleArgs);
  } catch (err) {
    // recordActualCost atomically releases the lease AND books used_usd, so a
    // failure leaves both undone. Retry once (mirrors executeSyncChat) before
    // falling back to the lease-cleanup sweep, so the audit row and budget state
    // don't disagree for a merely transient blip.
    deps.log?.error({ err }, "failed to settle embeddings cost; retrying settlement once");
    try {
      await recordActualCost(pool, settleArgs);
    } catch (retryErr) {
      deps.log?.error(
        { err: retryErr },
        "cost settlement retry failed; leaving the reservation for the lease-cleanup sweep to reconcile",
      );
    }
  }

  const responseDecision: "allow" | "degrade" | "fallback" = usedFallback
    ? "fallback"
    : (decision.decision as "allow" | "degrade");

  let auditRequestId: string;
  try {
    auditRequestId = await logRequest(pool, {
      ...rowBase,
      resolvedModel: model,
      decision: responseDecision,
      status: "ok",
      actualCostUsd,
      inputTokens: result.inputTokens,
    });
  } catch {
    return { ok: false, status: 503, code: "audit_unavailable", details: {}, message: "Audit log unavailable" };
  }

  deps.observability?.recordChat({
    ...baseObs(aiRequest, decision),
    decision: responseDecision,
    status: "ok",
    model,
    inputTokens: result.inputTokens,
    actualCostUsd,
    reason: usedFallback
      ? "provider failure on primary — routed to fallback model"
      : decision.reason,
  });

  return {
    ok: true,
    body: {
      embeddings: result.embeddings,
      model,
      provider: providerOf(model),
      decision: responseDecision,
      reason: usedFallback ? "provider failure on primary — routed to fallback model" : decision.reason,
      usage: { inputTokens: result.inputTokens ?? null },
      cost: { estimatedUsd: decision.estimatedCostUsd, actualUsd: actualCostUsd },
      budgetRemaining: remainingAfter(decision.budgetRemaining, actualCostUsd),
      requestId: auditRequestId,
    },
  };
}

async function providerFailure(
  deps: EmbeddingsDeps,
  releaseHold: () => Promise<void>,
  rowBase: ReturnType<typeof baseLog>,
  model: string,
  err: unknown,
  obs: { aiRequest: AiRequest; decision: PolicyDecision },
): Promise<EmbeddingsResult> {
  await releaseHold();
  deps.log?.error({ err, model }, "embeddings provider failure");
  // A 4xx from the proxy (bad model/config) is not a transient outage — mark it
  // non-retryable with a distinct code so callers don't hammer a doomed request.
  const isClientError = err instanceof LiteLLMClientError;
  const code = isClientError ? "upstream_rejected" : "provider_unavailable";
  const message = isClientError
    ? "Embedding provider rejected the request"
    : "Embedding provider unavailable";
  await tryLog(deps, { ...rowBase, resolvedModel: model, status: "failed", error: code });
  deps.observability?.recordChat({
    ...baseObs(obs.aiRequest, obs.decision),
    status: "error",
    model,
    reason: code,
  });
  return { ok: false, status: 502, code, details: {}, message, retryable: !isClientError };
}

async function tryLog(
  deps: EmbeddingsDeps,
  row: Parameters<typeof logRequest>[1],
): Promise<string | undefined> {
  try {
    return await logRequest(deps.pool, row);
  } catch (err) {
    deps.log?.error({ err }, "failed to write embeddings audit row");
    return undefined;
  }
}
