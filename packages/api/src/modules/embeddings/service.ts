import {
  evaluateAiRequest,
  PolicyConfigError,
  providerOf,
  type ModelgovConfig,
  type AiRequest,
  type BudgetRemaining,
  type PolicyDecision,
  type SafetyPlan,
} from "@modelgov/policy-engine";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import type { BillingService } from "../billing/service";
import { acquireCreditHold } from "../billing/reserve";
import { releaseBillingCredits, settleBillingCredits } from "../billing/settlement";
import { loadUsageSnapshot, reserveBudget, settleActualCostWithRetry } from "../usage/repo";
import { createFlatProviderBudget } from "../chat/providerBudget";
import type { TopUpOutcome } from "../chat/lifecycle";
import { logRequest } from "../usage/auditLogRepo";
import { baseLog, baseObs, remainingAfter } from "../chat/mapper";
import type { Observability } from "../../services/observability";
import {
  LiteLLMClientError,
  ProviderError,
  type LiteLLMClient,
} from "../../services/litellm";
import { SafetyServiceError, type SafetyGuard } from "../../services/safety";
import { messageText } from "../../types";
import type { EmbeddingsInput } from "./schemas";

export interface EmbeddingsDeps {
  config: ModelgovConfig;
  pool: Pool;
  litellm: LiteLLMClient;
  /** Enforces the feature's PII plan on the embedding input. Embeddings ship the
   * caller text to the provider (and usually into a vector store), so raw PII
   * must be masked/blocked before the call — the same guarantee chat gives. */
  safety: SafetyGuard;
  /** Optional tracing/metrics sink. When set, every embeddings outcome is
   * recorded the same way chat outcomes are (spend + decision visibility). */
  observability?: Observability;
  /** Prepaid-credit / metered billing. Embeddings incur real provider spend, so
   * they must ride the same wallet/meter as chat or they'd be a billing bypass. */
  billing?: BillingService;
  policyMeta?: { configHash?: string; policyVersion?: string; tenantId?: string; correlationId?: string };
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
 * OpenAI-compatible /embeddings call. Input PII is masked/blocked before the
 * provider call per the feature's plan (see below); there is no OUTPUT safety
 * (a vector has no text to screen) and no injection classifier (embedding input
 * is data, not instructions). Every call declares its feature and user type, is
 * checked before the provider runs, reserves budget, settles the real cost, and
 * lands one audit row.
 *
 * The hold lifecycle (fallback top-up + release) rides the shared
 * `createFlatProviderBudget` context so the credit/internal lease bookkeeping is
 * the same code the chat pipeline uses — not a divergent copy.
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
    // Never trust a caller-supplied estimate BELOW the server's own content-based
    // floor — otherwise a near-zero `inputTokensEstimate` under-reserves budget
    // and slips a huge batch past the token/USD gates (chat applies the same
    // floor in prep.ts). Take the larger of the two.
    inputTokensEstimate: Math.max(
      input.inputTokensEstimate ?? 0,
      estimateTokensFromText(texts),
    ),
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

  // ── Input PII (mask/block) — before any spend or provider call ─────────────
  // Embeddings send the caller text to the provider (and typically persist it in
  // a vector store), so raw PII must be handled first, exactly like chat input.
  // Run a PII-ONLY plan: the injection classifier is skipped (embedding input is
  // data, not instructions). Fails closed (503) on a safety backend outage, and
  // charges nothing on a PII block (PII masking incurs no classifier cost).
  let embedTexts = texts;
  // Force piiScope=input: embedding text is INPUT that reaches the provider (and
  // usually a vector store) and has NO output side to catch anything later. A
  // chat-oriented `pii_scope: output` config would otherwise make CompositeGuard
  // skip input masking here (piiOnInput = pii !== "off" && piiScope !== "output"),
  // silently sending raw PII to the provider. Injection is off (data, not
  // instructions).
  const piiOnlyPlan: SafetyPlan = {
    ...decision.safetyPlan,
    promptInjection: "off",
    piiScope: "input",
  };
  let safetyResult;
  try {
    safetyResult = await deps.safety.inspectInput(
      texts.map((t) => ({ role: "user" as const, content: t })),
      piiOnlyPlan,
    );
  } catch (err) {
    if (err instanceof SafetyServiceError) {
      deps.log?.error({ err }, "embeddings safety backend failure");
      const auditRequestId = await tryLog(deps, { ...rowBase, status: "failed", error: "safety_unavailable" });
      return {
        ok: false,
        status: 503,
        code: "safety_unavailable",
        details: {},
        message: "Safety service unavailable",
        retryable: true,
        auditRequestId,
      };
    }
    throw err;
  }
  if (safetyResult.action === "block") {
    const auditRequestId = await tryLog(deps, {
      ...rowBase,
      status: "safety_blocked",
      error: safetyResult.blockReason,
    });
    deps.observability?.recordChat({
      ...baseObs(aiRequest, decision),
      status: "safety_blocked",
      reason: safetyResult.blockReason,
    });
    return {
      ok: false,
      status: 403,
      code: "safety_blocked",
      details: { reason: safetyResult.blockReason, findings: safetyResult.findings },
      message: "Safety Blocked",
      auditRequestId,
    };
  }
  if (safetyResult.piiMasked) {
    // Send the masked copy to the provider (order + count preserved 1:1).
    embedTexts = safetyResult.messages.map((m) => messageText(m.content));
  }

  // ── Prepaid credits: reserve BEFORE the internal ledger (parity with the chat
  // pipeline). In credits_only mode the wallet is the only ledger. ────────────
  const billing = deps.billing;
  const skipInternalBudget = billing?.enabled === true && billing.mode === "credits_only";
  const reservedUsd = decision.estimatedCostUsd;

  // Reserve prepaid credits under a per-request hold (shared with the chat
  // pipeline via acquireCreditHold so the reserve/gate/hold-id step can't drift).
  // The hold groups this request's wallet leases (base + fallback top-ups) for
  // the sweep. reserveCredits checks the balance atomically inside its UPDATE, so
  // the balance is read only on failure, to populate the 402 body.
  const hold = await acquireCreditHold(billing, tenantId ?? "", aiRequest.userId, reservedUsd);
  if (!hold.ok) {
    const auditRequestId = await tryLog(deps, {
      ...rowBase,
      status: "failed",
      error: "insufficient_credits",
      reasonCode: "insufficient_credits",
    });
    deps.observability?.recordChat({
      ...baseObs(aiRequest, decision),
      status: "blocked",
      reason: "insufficient_credits",
    });
    return {
      ok: false,
      status: 402,
      code: "insufficient_credits",
      details: {
        reasonCode: "insufficient_credits",
        creditsAvailableUsd: hold.availableUsd,
        estimatedCostUsd: reservedUsd,
      },
      message: "Insufficient credits",
      auditRequestId,
    };
  }
  const creditHoldId = hold.holdId;

  // ── Reserve budget (row-locked) — a concurrent request may have consumed it ──
  let leaseId: string | undefined;
  if (!skipInternalBudget) {
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
      // No provider budget context yet (the internal reserve failed), so release
      // the credit hold directly.
      await releaseBillingCredits(billing, deps.log, {
        tenantId: tenantId ?? "",
        userId: aiRequest.userId,
        reservedUsd,
        creditHoldId,
      });
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
    leaseId = reservation.leaseId;
  }

  // Shared flat budget context — its `release` (credit + internal) and `topUp`
  // (pricier-fallback reserve/rollback) are the exact logic the chat pipeline
  // uses, so the money paths can't drift. safetyCostUsd is 0: embeddings run no
  // injection classifier.
  const providerBudget = createFlatProviderBudget({
    pool,
    aiRequest,
    decision,
    now,
    leaseId,
    initialReservedUsd: reservedUsd,
    tenantId,
    billing,
    skipInternalBudget,
    safetyCostUsd: 0,
    creditHoldId,
  });

  // ── Provider call (single fallback on a provider-side failure) ──────────────
  let model = decision.resolvedModel;
  let usedFallback = false;
  let result: Awaited<ReturnType<NonNullable<LiteLLMClient["embed"]>>>;
  try {
    result = await deps.litellm.embed({ model, input: embedTexts });
  } catch (err) {
    if (err instanceof ProviderError && decision.fallbackModel) {
      // Re-evaluate with forceFallback so the fallback model/provider is re-run
      // through the data-sensitivity gate (mirrors the chat pipeline) — a fallback
      // must not route restricted data to an unapproved provider.
      const fb = evaluateAiRequest({ request: { ...aiRequest, forceFallback: true }, config, usage });
      if (fb.decision === "block") {
        await providerBudget.release();
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
      // reservation (credits first, then internal); reject if that top-up
      // breaches a cap. providerBudget.topUp does the same reserve/rollback the
      // chat pipeline uses.
      if (fb.estimatedCostUsd > providerBudget.getReservedUsd()) {
        const additionalUsd = fb.estimatedCostUsd - providerBudget.getReservedUsd();
        let topUp: TopUpOutcome;
        try {
          topUp = await providerBudget.topUp!(additionalUsd);
        } catch (topErr) {
          // topUp re-threw a non-rejection error (lock timeout / DB failure)
          // AFTER rolling back the extra credit hold — free the base hold and
          // surface a retryable 503.
          await providerBudget.release();
          deps.log?.error({ err: topErr }, "embeddings fallback budget top-up failed");
          const auditRequestId = await tryLog(deps, {
            ...rowBase,
            resolvedModel: fb.resolvedModel,
            status: "failed",
            error: "budget_unavailable",
          });
          return {
            ok: false,
            status: 503,
            code: "budget_unavailable",
            details: {},
            message: "Budget service unavailable",
            retryable: true,
            auditRequestId,
          };
        }
        if (!topUp.ok) {
          await providerBudget.release();
          const auditRequestId = await tryLog(deps, {
            ...rowBase,
            resolvedModel: fb.resolvedModel,
            status: "failed",
            error: topUp.insufficientCredits ? "insufficient_credits" : `budget_exceeded:${topUp.failedScope}`,
            ...(topUp.insufficientCredits ? { reasonCode: "insufficient_credits" as const } : {}),
          });
          return topUp.insufficientCredits
            ? {
                ok: false,
                status: 402,
                code: "insufficient_credits",
                details: { reasonCode: "insufficient_credits" },
                message: "Insufficient credits for the fallback model",
                auditRequestId,
              }
            : {
                ok: false,
                status: 403,
                code: "budget_exceeded",
                details: { scope: topUp.failedScope, budgetRemaining: decision.budgetRemaining },
                message: "Budget exceeded",
                auditRequestId,
              };
        }
        providerBudget.setReservedUsd(fb.estimatedCostUsd);
      }
      try {
        model = fb.resolvedModel;
        usedFallback = true;
        result = await deps.litellm.embed({ model, input: embedTexts });
      } catch (fallbackErr) {
        return providerFailure(deps, providerBudget.release, rowBase, model, fallbackErr, { aiRequest, decision });
      }
    } else {
      return providerFailure(deps, providerBudget.release, rowBase, model, err, { aiRequest, decision });
    }
  }

  // ── Settle real cost against the (possibly grown) reservation ───────────────
  const settledReservedUsd = providerBudget.getReservedUsd();
  const actualCostUsd = result.actualCostUsd ?? settledReservedUsd;
  const actualTokens = result.inputTokens ?? 0;
  // The ONE billing-settlement exit for the post-provider phase (wallet debit in
  // credits modes, meter row in metered mode) — parity with executeSyncChat.
  const settleBilling = (requestId: string) =>
    settleBillingCredits(billing, deps.log, {
      tenantId: tenantId ?? "",
      userId: aiRequest.userId,
      feature: aiRequest.feature,
      reservedUsd: settledReservedUsd,
      actualCostUsd,
      requestId,
      creditHoldId,
    });
  if (!skipInternalBudget) {
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
        leaseId,
        tenantId,
      },
      deps.log,
    );
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
      // Persist that input PII was masked so a masked request is distinguishable
      // from a clean one in the audit trail (parity with the chat success row).
      piiMasked: safetyResult.piiMasked,
      ...(safetyResult.findings.length > 0 ? { safetyFindings: safetyResult.findings } : {}),
    });
  } catch {
    // The provider ran (spend is real) but the audit write failed — settle the
    // reservation anyway (meter keyed by a synthetic id in metered mode). Mark
    // NOT retryable so the idempotency layer caches this failure rather than
    // releasing the key, which would let a retry re-call the provider + re-charge.
    await settleBilling("");
    return { ok: false, status: 503, code: "audit_unavailable", details: {}, message: "Audit log unavailable", retryable: false };
  }

  await settleBilling(auditRequestId);

  deps.observability?.recordChat({
    ...baseObs(aiRequest, decision),
    decision: responseDecision,
    status: "ok",
    model,
    inputTokens: result.inputTokens,
    actualCostUsd,
    piiMasked: safetyResult.piiMasked,
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
