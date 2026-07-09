import {
  evaluateAiRequest,
  PolicyConfigError,
  roundUsd,
  type ModelgovConfig,
  type AiRequest,
  type BudgetRemaining,
  type PolicyDecision,
} from "@modelgov/policy-engine";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import type { BillingService } from "../billing/service";
import { acquireCreditHold } from "../billing/reserve";
import { releaseBillingCredits, settleBillingCredits } from "../billing/settlement";
import { loadUsageSnapshot, reserveBudget, settleActualCostWithRetry } from "../usage/repo";
import { createFlatProviderBudget } from "../chat/providerBudget";
import { logRequest } from "../usage/auditLogRepo";
import { baseLog, baseObs, remainingAfter } from "../chat/mapper";
import type { Observability } from "../../services/observability";
import { SafetyServiceError, type SafetyGuard } from "../../services/safety";
import {
  assertFetchableDocumentUrl,
  DocumentClientError,
  type DocumentAiClient,
  type DocumentSource,
} from "../../services/documents";
import type { DocumentBody } from "./schemas";

export interface DocumentServiceDeps {
  config: ModelgovConfig;
  pool: Pool;
  documentClient: DocumentAiClient;
  /** Enforces the feature's PII plan on the EXTRACTED text (output side). */
  safety: SafetyGuard;
  observability?: Observability;
  /** Document extraction incurs real provider spend, so it rides the same
   *  wallet/meter as chat — not a billing bypass. */
  billing?: BillingService;
  policyMeta?: { configHash?: string; policyVersion?: string; tenantId?: string; correlationId?: string };
  /**
   * Worst-case pages reserved per request. The budget cap is checked against
   * this (page count is unknown until after OCR, and the caller cannot be
   * trusted to declare it), so a caller can't under-report to slip past a cap.
   * Actual pages are settled afterwards.
   */
  maxPages: number;
  log?: FastifyBaseLogger;
}

export interface DocumentSuccessBody {
  text: string;
  pages: number;
  provider: string;
  model?: string;
  decision: "allow" | "degrade";
  reason?: string;
  cost: { estimatedUsd: number; actualUsd: number };
  budgetRemaining: BudgetRemaining | null;
  safety: { piiMasked: boolean };
  requestId: string;
}

export type DocumentExtractResult =
  | { ok: true; body: DocumentSuccessBody }
  | {
      ok: false;
      status: number;
      code: string;
      details: Record<string, unknown>;
      message?: string;
      auditRequestId?: string;
      retryable?: boolean;
    };

function toSource(document: DocumentBody["document"]): DocumentSource {
  if (document.base64 !== undefined) return { kind: "base64", base64: document.base64 };
  if (document.url !== undefined) return { kind: "url", url: document.url };
  if (document.s3 !== undefined) return { kind: "s3", s3: document.s3 };
  // The zod schema guarantees exactly one source; this keeps the invariant local
  // instead of leaning on a non-null assertion tied to a refine in another file.
  throw new DocumentClientError("document must have exactly one of base64, url, or s3");
}

/**
 * Governed document extraction: the same policy/budget/audit/billing spine as
 * embeddings, but the cost basis is PAGES×perPageUsd (not tokens) and PII is
 * masked on the OUTPUT (the extracted text), since a scanned document's PII is
 * discovered only after OCR. The gateway calls the provider directly via the
 * injected {@link DocumentAiClient}. The audit row is a first-class request
 * (`decision` allow/degrade, NOT 'external'), carrying the correlation id — so a
 * document call rolls up in /v1/usage/transactions alongside LLM calls and is
 * counted + budget-enforced like any governed request.
 */
export async function handleDocumentExtract(
  deps: DocumentServiceDeps,
  input: DocumentBody,
): Promise<DocumentExtractResult> {
  const { config, pool } = deps;
  const tenantId = deps.policyMeta?.tenantId;
  const now = new Date();

  // Provider is enabled iff configured; absent → 400.
  const adapter = deps.documentClient.get(input.provider);
  if (!adapter) {
    return {
      ok: false,
      status: 400,
      code: "provider_unavailable",
      details: { provider: input.provider, enabled: deps.documentClient.providers() },
      message: `document provider '${input.provider}' is not configured`,
    };
  }

  let source: DocumentSource;
  try {
    source = toSource(input.document);
  } catch (err) {
    return { ok: false, status: 400, code: "invalid_request", details: { detail: (err as Error).message } };
  }
  if (!adapter.supportedInputs.includes(source.kind)) {
    return {
      ok: false,
      status: 400,
      code: "unsupported_source",
      details: { provider: input.provider, kind: source.kind, supported: adapter.supportedInputs },
      message: `provider '${input.provider}' does not support a '${source.kind}' source`,
    };
  }
  // SSRF guard for url sources — DNS-resolve and reject private/link-local hosts
  // (the URL is untrusted caller input, so the syntactic check alone is not
  // enough). Applied uniformly: the gateway fetches for Tesseract/Textract, and
  // even for Azure DI (which pulls the url itself) we refuse an internal host.
  if (source.kind === "url") {
    try {
      assertFetchableDocumentUrl(source.url);
    } catch (err) {
      return { ok: false, status: 400, code: "invalid_request", details: { detail: (err as Error).message } };
    }
  }

  const aiRequest: AiRequest = {
    projectId: input.projectId ?? config.project.name,
    environment: input.environment ?? config.project.environment,
    userId: input.userId,
    userType: input.userType,
    feature: input.feature,
    requestedModelClass: input.modelClass,
    // Documents are page-priced; the token estimate is unused for cost but the
    // engine still gives us budget caps + safety plan + policy gating.
    inputTokensEstimate: 0,
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

  // Reservation floored at maxPages: the caller's `pages` can only RAISE the
  // reserve (an honest large-doc hint), never lower it below the worst-case
  // floor — so a caller can't under-report pages to slip a big document past a
  // budget cap. Actual pages are settled afterwards.
  const estimatedPages = Math.max(input.pages ?? 0, deps.maxPages);
  const reservedUsd = roundUsd(estimatedPages * adapter.perPageUsd);

  // Base audit row for THIS request: stamp the page-based reserved amount as the
  // estimate (baseLog's token estimate is 0 for documents) and default the model
  // to the provider slug for pre-extract failure rows.
  const rowBase = { ...baseLog(aiRequest, decision, deps.policyMeta), estimatedCostUsd: reservedUsd, resolvedModel: input.provider };

  // One place to leave a failure's audit row + observability event, then return
  // the error envelope — the six failure paths differ only in these fields.
  const failure = async (args: {
    status: "failed" | "safety_blocked";
    error?: string;
    actualCostUsd?: number;
    resolvedModel?: string;
    obsStatus: "blocked" | "error" | "safety_blocked";
    obsReason?: string;
    http: { status: number; code: string; details?: Record<string, unknown>; message?: string; retryable?: boolean };
  }): Promise<Extract<DocumentExtractResult, { ok: false }>> => {
    const rm = args.resolvedModel ?? input.provider;
    const auditRequestId = await tryLog(deps, {
      ...rowBase,
      resolvedModel: rm,
      status: args.status,
      ...(args.error !== undefined ? { error: args.error } : {}),
      ...(args.actualCostUsd !== undefined ? { actualCostUsd: args.actualCostUsd } : {}),
    });
    deps.observability?.recordChat({
      ...baseObs(aiRequest, decision),
      status: args.obsStatus,
      model: rm,
      ...(args.obsReason !== undefined ? { reason: args.obsReason } : {}),
      ...(args.actualCostUsd !== undefined ? { actualCostUsd: args.actualCostUsd } : {}),
    });
    return { ok: false, ...args.http, details: args.http.details ?? {}, auditRequestId };
  };

  // ── Policy block — audit and reject, no spend ──────────────────────────────
  if (decision.decision === "block") {
    return failure({
      status: "failed",
      error: decision.reasonCode ?? "policy_blocked",
      obsStatus: "blocked",
      obsReason: decision.reason,
      http: {
        status: 403,
        code: "policy_blocked",
        details: { reasonCode: decision.reasonCode, reason: decision.reason, budgetRemaining: decision.budgetRemaining },
        message: decision.reason ?? "Request blocked by policy",
      },
    });
  }

  const billing = deps.billing;
  const skipInternalBudget = billing?.enabled === true && billing.mode === "credits_only";

  const hold = await acquireCreditHold(billing, tenantId ?? "", aiRequest.userId, reservedUsd);
  if (!hold.ok) {
    return failure({
      status: "failed",
      error: "insufficient_credits",
      obsStatus: "blocked",
      obsReason: "insufficient_credits",
      http: {
        status: 402,
        code: "insufficient_credits",
        details: { reasonCode: "insufficient_credits", creditsAvailableUsd: hold.availableUsd, estimatedCostUsd: reservedUsd },
        message: "Insufficient credits",
      },
    });
  }
  const creditHoldId = hold.holdId;

  // ── Reserve budget (row-locked) ────────────────────────────────────────────
  let leaseId: string | undefined;
  if (!skipInternalBudget) {
    const reservation = await reserveBudget(pool, {
      projectId: aiRequest.projectId,
      userId: aiRequest.userId,
      feature: aiRequest.feature,
      estimatedCostUsd: reservedUsd,
      // Documents don't consume the token budget — reserve zero tokens.
      estimatedTokens: 0,
      caps: decision.reservationCaps,
      now,
      tenantId,
    });
    if (!reservation.ok) {
      await releaseBillingCredits(billing, deps.log, {
        tenantId: tenantId ?? "",
        userId: aiRequest.userId,
        reservedUsd,
        creditHoldId,
      });
      return failure({
        status: "failed",
        error: `budget_exceeded:${reservation.failedScope}`,
        obsStatus: "blocked",
        obsReason: `budget_exceeded:${reservation.failedScope}`,
        http: {
          status: 403,
          code: "budget_exceeded",
          details: { scope: reservation.failedScope, budgetRemaining: decision.budgetRemaining },
          message: "Budget exceeded",
        },
      });
    }
    leaseId = reservation.leaseId;
  }

  // Shared flat budget context — its `release` (credit + internal lease) is the
  // same code the chat/embeddings pipelines use. No topUp (documents don't fall back).
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

  // ── Provider call (the second egress — gateway calls the provider directly) ─
  let extracted;
  try {
    extracted = await adapter.extract(source);
  } catch (err) {
    await providerBudget.release();
    deps.log?.error({ err, provider: input.provider }, "document provider failure");
    const isClient = err instanceof DocumentClientError;
    return failure({
      status: "failed",
      error: isClient ? "upstream_rejected" : "provider_unavailable",
      obsStatus: "error",
      obsReason: isClient ? "upstream_rejected" : "provider_unavailable",
      http: {
        status: 502,
        code: isClient ? "upstream_rejected" : "provider_unavailable",
        message: isClient ? "Document provider rejected the request" : "Document provider unavailable",
        retryable: !isClient,
      },
    });
  }

  if (extracted.pages > estimatedPages) {
    // The document had more pages than were reserved; the provider already billed
    // for all pages, so settle the real cost but flag the overshoot (parity with
    // chat's "actual exceeded reserved estimate" warning).
    deps.log?.warn(
      { provider: input.provider, pages: extracted.pages, reservedPages: estimatedPages },
      "document pages exceeded the reservation — actual cost overshoots the reserved estimate",
    );
  }

  // ── Settle real cost against the reservation (pages actually processed) ─────
  const settledReservedUsd = providerBudget.getReservedUsd();
  const actualCostUsd = roundUsd(extracted.pages * adapter.perPageUsd);
  const resolvedModel = extracted.model ?? input.provider;
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
        actualTokens: 0,
        estimatedTokens: 0,
        caps: decision.reservationCaps,
        now,
        leaseId,
        tenantId,
      },
      deps.log,
    );
  }

  // ── Output PII masking on the extracted text ───────────────────────────────
  let text = extracted.text;
  let piiMasked = false;
  try {
    const out = await deps.safety.inspectOutput(text, decision.safetyPlan);
    if (out.action === "block") {
      const blocked = await failure({
        status: "safety_blocked",
        resolvedModel,
        actualCostUsd,
        error: out.blockReason,
        obsStatus: "safety_blocked",
        obsReason: out.blockReason,
        http: {
          status: 403,
          code: "safety_blocked",
          details: { reason: out.blockReason, findings: out.findings },
          message: "Safety Blocked",
        },
      });
      // The provider ran — its cost is real. Settle before returning the block.
      await settleBilling(blocked.auditRequestId ?? "");
      return blocked;
    }
    text = out.content;
    piiMasked = out.piiMasked;
  } catch (err) {
    if (err instanceof SafetyServiceError) {
      deps.log?.error({ err }, "document output safety backend failure");
      const failed = await failure({
        status: "failed",
        resolvedModel,
        actualCostUsd,
        error: "safety_unavailable",
        obsStatus: "error",
        obsReason: "safety_unavailable",
        http: { status: 503, code: "safety_unavailable", message: "Safety service unavailable", retryable: false },
      });
      await settleBilling(failed.auditRequestId ?? "");
      return failed;
    }
    // Unexpected safety-backend error AFTER the provider ran: settle the real
    // cost so the credit hold isn't leaked, then rethrow (becomes a 500).
    await settleBilling("");
    throw err;
  }

  const responseDecision = decision.decision as "allow" | "degrade";

  let auditRequestId: string;
  try {
    auditRequestId = await logRequest(pool, {
      ...rowBase,
      resolvedModel,
      decision: responseDecision,
      status: "ok",
      actualCostUsd,
      piiMasked,
    });
  } catch {
    // The provider ran and cost is settled below; the audit write failed. Mark
    // NOT retryable so the idempotency layer CACHES this failure instead of
    // releasing the key — a retry would otherwise re-call the provider and
    // re-charge for work already done.
    await settleBilling("");
    return { ok: false, status: 503, code: "audit_unavailable", details: {}, message: "Audit log unavailable", retryable: false };
  }
  await settleBilling(auditRequestId);

  deps.observability?.recordChat({
    ...baseObs(aiRequest, decision),
    decision: responseDecision,
    status: "ok",
    model: resolvedModel,
    actualCostUsd,
    piiMasked,
  });

  return {
    ok: true,
    body: {
      text,
      pages: extracted.pages,
      provider: input.provider,
      model: extracted.model,
      decision: responseDecision,
      reason: decision.reason,
      cost: { estimatedUsd: reservedUsd, actualUsd: actualCostUsd },
      budgetRemaining: remainingAfter(decision.budgetRemaining, actualCostUsd),
      safety: { piiMasked },
      requestId: auditRequestId,
    },
  };
}

async function tryLog(
  deps: DocumentServiceDeps,
  row: Parameters<typeof logRequest>[1],
): Promise<string | undefined> {
  try {
    return await logRequest(deps.pool, row);
  } catch (err) {
    deps.log?.error({ err }, "failed to write document audit row");
    return undefined;
  }
}
