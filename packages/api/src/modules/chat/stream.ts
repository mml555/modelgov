import { estimateCostUsd, getModelPrice, roundUsd } from "@modelgov/policy-engine";
import type { LiteLLMStreamFinal } from "../../services/litellm";
import { logRequest } from "../usage/auditLogRepo";
import { recordActualCost, recordIncurredCost, releaseBudget } from "../usage/repo";
import { releasePath, settlePath } from "../budgets/repo";
import { bookSafetyIfAny, releaseWithSafety } from "./lifecycle";
import { prepareChatCall, type PreparedCall } from "./pipeline";
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
): Promise<string> {
  const { pool, observability, log } = deps;
  const { aiRequest, decision, hold, now, safetyCostUsd } = ctx;
  const reservedUsd = hold.reservedUsd;
  const actualCostUsd =
    final.actualCostUsd != null ? final.actualCostUsd + safetyCostUsd : reservedUsd;

  try {
    if (hold.mode === "flat") {
      await recordActualCost(pool, {
        projectId: aiRequest.projectId,
        userId: aiRequest.userId,
        feature: aiRequest.feature,
        actualCostUsd,
        estimatedCostUsd: reservedUsd,
        actualTokens: (final.inputTokens ?? 0) + (final.outputTokens ?? 0),
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

  const requestId = await logRequest(pool, {
    ...baseLog(aiRequest, decision, deps.policyMeta),
    resolvedModel: final.model,
    status: "ok",
    actualCostUsd,
    inputTokens: final.inputTokens,
    outputTokens: final.outputTokens,
    piiMasked: ctx.piiMasked,
    injectionBlocked: ctx.injectionBlocked,
  });
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

  try {
    if (hold.mode === "flat") {
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

  try {
    await logRequest(pool, {
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
  try {
    if (hold.mode === "flat") {
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
      return;
    }
    const incur = createHierarchicalIncurSafety(deps.pool, hold.nodes, now, hold.shardKey);
    await bookSafetyIfAny(incur, safetyCostUsd);
    await releasePath(deps.pool, hold.held);
  } catch (err) {
    deps.log?.error({ err }, "failed to release stream reservation; lease sweep will reconcile");
  }
}
