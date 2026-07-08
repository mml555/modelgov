import { estimateCostUsd, getModelPrice, roundUsd } from "@modelgov/policy-engine";
import type { LiteLLMStreamFinal } from "../../services/litellm";
import { logRequest } from "../usage/auditLogRepo";
import { recordActualCost, recordIncurredCost, releaseBudget } from "../usage/repo";
import { releasePath, settlePath } from "../budgets/repo";
import { bookSafetyIfAny, releaseBillingCredits, releaseWithSafety, settleBillingCredits } from "./lifecycle";
import { prepareChatCall, type PreparedCall } from "./prepare";
import { createHierarchicalIncurSafety } from "./prep-hierarchical";
import { baseLog, baseObs } from "./mapper";
import type { ChatFailure, ChatInput, ChatServiceDeps } from "./types";

export type StreamContext = PreparedCall;

export type StreamPrep = ChatFailure | { ok: true; ctx: StreamContext };

export async function prepareStream(
  deps: ChatServiceDeps,
  body: ChatInput,
  leafNodeId?: string,
): Promise<StreamPrep> {
  const prep = await prepareChatCall(deps, body, { leafNodeId, stream: true });
  if (prep.ok !== true) return prep;
  return { ok: true, ctx: prep.prepared };
}

export async function settleStream(
  deps: ChatServiceDeps,
  ctx: StreamContext,
  final: LiteLLMStreamFinal,
  outputChars = 0,
): Promise<string> {
  const { pool, observability, log } = deps;
  const { aiRequest, decision, hold, now, safetyCostUsd } = ctx;
  const reservedUsd = hold.reservedUsd;
  // Prefer the provider-reported cost. If the upstream proxy didn't return usage
  // (some LiteLLM versions omit it unless stream_options.include_usage is honored),
  // do NOT fall back to the full worst-case reservation — that systematically
  // overcharges (e.g. billing 1000 output tokens for a 30-token reply). Estimate
  // from provider token counts when present, otherwise from the input floor and
  // the characters actually streamed to the client, capped at the reservation.
  const model = final.model || decision.resolvedModel;
  const actualCostUsd =
    final.actualCostUsd != null
      ? final.actualCostUsd + safetyCostUsd
      : Math.min(
          roundUsd(
            estimateCostUsd(
              model,
              final.inputTokens ?? aiRequest.inputTokensEstimate,
              final.outputTokens ?? Math.ceil(Math.max(0, outputChars) / CHARS_PER_TOKEN),
              deps.config.pricing,
            ) + safetyCostUsd,
          ),
          reservedUsd,
        );
  // credits_only: the wallet is the sole ledger; the internal reserve was skipped
  // so there is no lease to settle — touching budget_counters here would UPSERT a
  // spurious row. settleBillingCredits below debits the wallet. (Parity with
  // executeSyncChat's skipInternalBudget guard.)
  const skipInternalBudget =
    deps.billing?.enabled === true && deps.billing.mode === "credits_only";

  try {
    if (skipInternalBudget) {
      // no internal ledger in credits_only
    } else if (hold.mode === "flat") {
      await recordActualCost(pool, {
        projectId: aiRequest.projectId,
        userId: aiRequest.userId,
        feature: aiRequest.feature,
        actualCostUsd,
        estimatedCostUsd: reservedUsd,
        // Mirror the cost fallback above: when the provider omits the usage chunk
        // (some LiteLLM versions do), estimate tokens from the emitted chars
        // instead of booking 0 — otherwise streamed requests never deplete a
        // token-only cap (userDailyTokens / featureMonthlyTokens).
        actualTokens:
          (final.inputTokens ?? aiRequest.inputTokensEstimate ?? 0) +
          (final.outputTokens ?? Math.ceil(Math.max(0, outputChars) / CHARS_PER_TOKEN)),
        estimatedTokens: decision.estimatedTokens,
        caps: decision.reservationCaps,
        now,
        leaseId: hold.leaseId,
        tenantId: deps.policyMeta?.tenantId,
      });
    } else {
      await settlePath(pool, hold.held, actualCostUsd);
    }
  } catch (err) {
    log?.error({ err }, "stream cost settlement failed; leaving lease for sweep");
  }

  // The audit write must not gate credit settlement: if logRequest throws, the
  // route's `finished` guard skips the partial-settle fallback, so without this
  // the credit reservation would leak (no wallet reconciliation sweep exists).
  let requestId = "";
  try {
    requestId = await logRequest(pool, {
      ...baseLog(aiRequest, decision, deps.policyMeta),
      resolvedModel: final.model,
      status: "ok",
      actualCostUsd,
      inputTokens: final.inputTokens,
      outputTokens: final.outputTokens,
      piiMasked: ctx.piiMasked,
      injectionBlocked: ctx.injectionBlocked,
    });
  } catch (err) {
    log?.error({ err }, "stream success audit write failed; settling credits regardless");
  }
  observability.recordChat({
    ...baseObs(aiRequest, decision),
    status: "ok",
    model: final.model,
    inputTokens: final.inputTokens,
    outputTokens: final.outputTokens,
    actualCostUsd,
    piiMasked: ctx.piiMasked,
    injectionBlocked: ctx.injectionBlocked,
  });
  await settleBillingCredits(deps.billing, log, {
    tenantId: deps.policyMeta?.tenantId ?? "",
    userId: aiRequest.userId,
    feature: aiRequest.feature,
    reservedUsd,
    actualCostUsd,
    requestId,
    creditHoldId: ctx.hold.mode === "flat" ? ctx.hold.creditHoldId : undefined,
  });
  return requestId;
}

// ~4 characters per token is the standard rough proxy for OpenAI-family
// tokenizers; used only to estimate partial output when a stream is cut short.
const CHARS_PER_TOKEN = 4;

/**
 * Settle a stream that was cut short (client disconnect or a mid-stream provider
 * failure) for the tokens actually produced, instead of refunding the whole
 * reservation. The provider bills for what it generated before the cut, so a
 * full release is a budget leak: a client can stream thousands of tokens, drop
 * the socket, and pay nothing. We have the emitted text in hand, so estimate the
 * output tokens from it (input is charged in full — the prompt was sent and
 * processed), price it with the same table the reservation used, and cap the
 * charge at the reserved amount so a rough estimate can never over-book. The
 * lease is dropped by the settle so the sweep won't touch it.
 */
export async function settleStreamPartial(
  deps: ChatServiceDeps,
  ctx: StreamContext,
  outputChars: number,
  outcome: "client_disconnect" | "stream_interrupted",
): Promise<void> {
  const { pool, observability, log } = deps;
  const { aiRequest, decision, hold, now, safetyCostUsd } = ctx;
  const model = decision.resolvedModel;
  const estOutputTokens = Math.ceil(Math.max(0, outputChars) / CHARS_PER_TOKEN);
  const price = getModelPrice(model, deps.config.pricing);
  // Input charged in full (prompt was processed); output for what was produced.
  const inputCost = estimateCostUsd(model, aiRequest.inputTokensEstimate, 0, deps.config.pricing);
  const outputCost = roundUsd((estOutputTokens / 1000) * price.outputPer1k);
  const actualCostUsd = Math.min(
    roundUsd(inputCost + outputCost + safetyCostUsd),
    hold.reservedUsd,
  );
  const estInputTokens = aiRequest.inputTokensEstimate ?? 0;
  // credits_only: wallet is the sole ledger (no internal lease to settle).
  const skipInternalBudget =
    deps.billing?.enabled === true && deps.billing.mode === "credits_only";

  try {
    if (skipInternalBudget) {
      // no internal ledger in credits_only
    } else if (hold.mode === "flat") {
      await recordActualCost(pool, {
        projectId: aiRequest.projectId,
        userId: aiRequest.userId,
        feature: aiRequest.feature,
        actualCostUsd,
        estimatedCostUsd: hold.reservedUsd,
        actualTokens: estInputTokens + estOutputTokens,
        estimatedTokens: decision.estimatedTokens,
        caps: decision.reservationCaps,
        now,
        leaseId: hold.leaseId,
        tenantId: deps.policyMeta?.tenantId,
      });
    } else {
      await settlePath(pool, hold.held, actualCostUsd);
    }
  } catch (err) {
    log?.error({ err }, "partial stream settlement failed; leaving lease for sweep");
  }

  let requestId: string | undefined;
  try {
    requestId = await logRequest(pool, {
      ...baseLog(aiRequest, decision, deps.policyMeta),
      resolvedModel: model,
      status: "ok",
      actualCostUsd,
      inputTokens: estInputTokens || undefined,
      outputTokens: estOutputTokens,
      piiMasked: ctx.piiMasked,
      injectionBlocked: ctx.injectionBlocked,
      traceTags: { ...decision.traceTags, streamOutcome: outcome },
    });
  } catch (err) {
    log?.error({ err }, "failed to audit partial stream settlement");
  }
  await settleBillingCredits(deps.billing, log, {
    tenantId: deps.policyMeta?.tenantId ?? "",
    userId: aiRequest.userId,
    feature: aiRequest.feature,
    reservedUsd: hold.reservedUsd,
    actualCostUsd,
    requestId: requestId ?? "",
    creditHoldId: hold.mode === "flat" ? hold.creditHoldId : undefined,
  });
  observability.recordChat({
    ...baseObs(aiRequest, decision),
    status: "ok",
    reason: outcome,
    model,
    inputTokens: estInputTokens || undefined,
    outputTokens: estOutputTokens,
    actualCostUsd,
    piiMasked: ctx.piiMasked,
    injectionBlocked: ctx.injectionBlocked,
  });
}

export async function releaseStream(deps: ChatServiceDeps, ctx: StreamContext): Promise<void> {
  const { hold, aiRequest, decision, now, safetyCostUsd } = ctx;
  // credits_only: wallet is the sole ledger — releaseBillingCredits below books
  // any incurred safety spend and frees the hold. Touching the internal counters
  // here (recordIncurredCost UPSERTs) would create spurious budget_counters rows.
  const skipInternalBudget =
    deps.billing?.enabled === true && deps.billing.mode === "credits_only";
  try {
    if (skipInternalBudget) {
      // no internal ledger in credits_only
    } else if (hold.mode === "flat") {
      await releaseWithSafety(
        (costUsd) =>
          recordIncurredCost(deps.pool, {
            projectId: aiRequest.projectId,
            userId: aiRequest.userId,
            feature: aiRequest.feature,
            costUsd,
            caps: decision.reservationCaps,
            now,
            tenantId: deps.policyMeta?.tenantId,
          }),
        () =>
          releaseBudget(deps.pool, {
            projectId: aiRequest.projectId,
            userId: aiRequest.userId,
            feature: aiRequest.feature,
            estimatedCostUsd: hold.reservedUsd,
            estimatedTokens: decision.estimatedTokens,
            caps: decision.reservationCaps,
            now,
            leaseId: hold.leaseId,
            tenantId: deps.policyMeta?.tenantId,
          }),
        safetyCostUsd,
      );
    } else {
      const incur = createHierarchicalIncurSafety(deps.pool, hold.nodes, now, hold.shardKey);
      await bookSafetyIfAny(incur, safetyCostUsd);
      await releasePath(deps.pool, hold.held);
    }
  } catch (err) {
    deps.log?.error({ err }, "failed to release stream reservation; lease sweep will reconcile");
  }
  // Release the credit reservation too — no model spend, but book any incurred
  // safety/classifier spend from credits rather than refunding the whole hold.
  await releaseBillingCredits(deps.billing, deps.log, {
    tenantId: deps.policyMeta?.tenantId ?? "",
    userId: aiRequest.userId,
    reservedUsd: hold.reservedUsd,
    incurredUsd: safetyCostUsd,
    creditHoldId: hold.mode === "flat" ? hold.creditHoldId : undefined,
  });
}
