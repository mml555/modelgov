import type { ModelgovConfig } from "@modelgov/policy-engine";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { sendError } from "../../errors";
import type { SafetyGuard } from "../../services/safety";
import type { Observability } from "../../services/observability";
import type { DocumentAiClient } from "../../services/documents";
import type { RequestContext } from "../../plugins/requestContext";
import {
  checkEnvironmentScope,
  checkProjectScope,
  checkUserIdAllowed,
  checkUserTypeAllowed,
  firstScopeDenial,
  mergeProjectEnvironment,
} from "../authz/scope";
import type { TenantPolicyResolver } from "../policy/tenantResolver";
import { useHierarchicalBudgets } from "../chat/routing";
import { assertAiRequestsNotPaused } from "../emergency/service";
import { parseIdempotencyKey, requestHash, withIdempotency } from "../idempotency/service";
import { errorJsonSchema } from "../chat/schemas";
import { documentBodyJsonSchema, documentBodySchema, documentSuccessJsonSchema, type DocumentBody } from "./schemas";
import { handleDocumentExtract, type DocumentServiceDeps } from "./service";

export interface DocumentsRouteDeps {
  config: ModelgovConfig;
  pool: Pool;
  documentClient: DocumentAiClient;
  safety: SafetyGuard;
  observability?: Observability;
  hierarchicalBudgets?: boolean;
  policyMeta?: { configHash?: string; policyVersion?: string; tenantId?: string; correlationId?: string };
  tenantPolicy?: TenantPolicyResolver;
  billing?: import("../billing/service").BillingService;
  /** When false, idempotency replays omit the extracted text at rest. */
  idempotencyCaptureContent?: boolean;
  /** Worst-case pages reserved per request (budget-cap floor). */
  maxPages: number;
}

/** Mirrors embeddings authorization: documents ride the `chat:create` data-plane
 *  key, plus project/environment/user scoping. */
function authorizeDocumentInput(
  ctx: RequestContext,
  body: DocumentBody,
):
  | { ok: true; value: DocumentBody }
  | { ok: false; status: number; code: string; message: string; details: Record<string, unknown> } {
  if (ctx.principalName && !ctx.permissions?.includes("chat:create")) {
    return { ok: false, status: 403, code: "forbidden", message: "API key is not permitted to extract documents", details: {} };
  }
  const denial = firstScopeDenial(
    checkProjectScope(ctx, body.projectId),
    checkEnvironmentScope(ctx, body.environment),
    checkUserTypeAllowed(ctx, body.userType),
    checkUserIdAllowed(ctx, body.userId),
  );
  if (denial) return denial;
  return { ok: true, value: mergeProjectEnvironment(ctx, body) };
}

export function registerDocumentsRoute(app: FastifyInstance, deps: DocumentsRouteDeps): void {
  app.post("/v1/documents/extract", {
    schema: {
      tags: ["documents"],
      body: documentBodyJsonSchema,
      response: {
        200: documentSuccessJsonSchema,
        400: errorJsonSchema,
        401: errorJsonSchema,
        402: errorJsonSchema,
        403: errorJsonSchema,
        501: errorJsonSchema,
        502: errorJsonSchema,
        503: errorJsonSchema,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = documentBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", {
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }

    const auth = authorizeDocumentInput(request.ctx, parsed.data);
    if (!auth.ok) {
      return sendError(reply, auth.status, auth.code, auth.details, auth.message);
    }

    // Per-tenant policy resolution (MULTI_TENANT_POLICY), same as chat/embeddings.
    const rdeps: DocumentsRouteDeps = deps.tenantPolicy
      ? { ...deps, ...(await deps.tenantPolicy.resolve(request.ctx.tenantId)) }
      : deps;

    // Documents only implement the flat budget path; fail closed on a node-scoped
    // key so it can't escape the node cap it was meant to enforce (parity w/ embeddings).
    if (useHierarchicalBudgets(rdeps.hierarchicalBudgets, request.ctx.budgetNodeId)) {
      return sendError(
        reply,
        501,
        "not_implemented",
        {},
        "Documents do not support hierarchical (node-tree) budgets; use a flat-budget API key",
      );
    }

    // Emergency pause blocks ALL new provider traffic — documents included.
    const pause = await assertAiRequestsNotPaused(rdeps.pool, request.ctx.tenantId);
    if (pause.paused) {
      return sendError(reply, 503, "ai_requests_paused", { reason: pause.reason ?? "emergency pause" }, "AI requests are temporarily paused");
    }

    const svc: DocumentServiceDeps = {
      config: rdeps.config,
      pool: rdeps.pool,
      documentClient: rdeps.documentClient,
      safety: rdeps.safety,
      observability: rdeps.observability,
      billing: rdeps.billing,
      maxPages: rdeps.maxPages,
      // Always stamp the correlation key (reused x-request-id) so a governed
      // document call rolls up with the LLM calls in the same transaction.
      policyMeta: {
        ...rdeps.policyMeta,
        correlationId: request.ctx.requestId,
        ...(request.ctx.tenantId ? { tenantId: request.ctx.tenantId } : {}),
      },
      log: request.log,
    };

    // Idempotency: a retried extract with the same key replays the stored result
    // instead of re-calling the provider and re-charging (documents incur real,
    // per-page spend). Mirrors chat/embeddings. A too-long key is treated as
    // absent (parity with embeddings).
    const rawKey = request.headers["idempotency-key"];
    const idempotencyKey = parseIdempotencyKey(rawKey);
    // A present-but-unusable key (too long) must be a loud 400, not silently
    // dropped — otherwise the client believes the call is idempotent while it
    // runs unprotected, and a retry re-calls the provider and double-charges
    // (parity with the chat route).
    const rawKeyStr = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (rawKeyStr && rawKeyStr.trim() !== "" && !idempotencyKey) {
      return sendError(reply, 400, "invalid_request", {}, "Idempotency-Key must be between 1 and 256 characters");
    }
    const run = () => handleDocumentExtract(svc, auth.value);

    let result;
    if (idempotencyKey) {
      const outcome = await withIdempotency(
        rdeps.pool,
        {
          key: idempotencyKey,
          userId: auth.value.userId,
          hash: requestHash(auth.value),
          captureContent: rdeps.idempotencyCaptureContent ?? false,
          tenantId: request.ctx.tenantId,
        },
        run,
      );
      result = outcome.result;
      reply.header("x-idempotent-replay", outcome.replayed ? "true" : "false");
    } else {
      result = await run();
    }

    if (!result.ok) {
      if (result.auditRequestId) reply.header("x-modelgov-request-id", result.auditRequestId);
      return sendError(reply, result.status, result.code, result.details, result.message, {
        ...(result.auditRequestId ? { auditRequestId: result.auditRequestId } : {}),
      });
    }

    if (result.body.requestId) reply.header("x-modelgov-request-id", result.body.requestId);
    return reply.code(200).send(result.body);
  });
}
