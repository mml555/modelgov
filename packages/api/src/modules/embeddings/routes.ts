import type { ModelgovConfig } from "@modelgov/policy-engine";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { sendError } from "../../errors";
import type { LiteLLMClient } from "../../services/litellm";
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
import { requestHash, withIdempotency } from "../idempotency/service";
import type { Observability } from "../../services/observability";
import {
  embeddingsBodyJsonSchema,
  embeddingsBodySchema,
  embeddingsSuccessJsonSchema,
  type EmbeddingsInput,
} from "./schemas";
import { errorJsonSchema } from "../chat/schemas";
import { handleEmbeddings, type EmbeddingsDeps } from "./service";
import { assertAiRequestsNotPaused } from "../emergency/routes";

export interface EmbeddingsRouteDeps {
  config: ModelgovConfig;
  pool: Pool;
  litellm: LiteLLMClient;
  observability?: Observability;
  idempotencyCaptureContent?: boolean;
  /** Enables node-tree budgets on chat. Embeddings do NOT implement the
   * hierarchical path, so this is used only to fail closed (see below). */
  hierarchicalBudgets?: boolean;
  policyMeta?: { configHash?: string; policyVersion?: string; tenantId?: string };
  tenantPolicy?: TenantPolicyResolver;
}

/**
 * API-key scoping for an embeddings request, mirroring chat authorization: the
 * data-plane `chat:create` permission (embeddings ride the same key), plus
 * project / environment / user-type / user-id allowlists.
 */
function authorizeEmbeddingsInput(
  ctx: RequestContext,
  body: EmbeddingsInput,
):
  | { ok: true; value: EmbeddingsInput }
  | { ok: false; status: number; code: string; message: string; details: Record<string, unknown> } {
  if (ctx.apiKeyName && !ctx.permissions?.includes("chat:create")) {
    return { ok: false, status: 403, code: "forbidden", message: "API key is not permitted to create embeddings", details: {} };
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

export function registerEmbeddingsRoute(
  app: FastifyInstance,
  deps: EmbeddingsRouteDeps,
): void {
  app.post("/v1/embeddings", {
    schema: {
      tags: ["embeddings"],
      body: embeddingsBodyJsonSchema,
      response: {
        200: embeddingsSuccessJsonSchema,
        400: errorJsonSchema,
        401: errorJsonSchema,
        403: errorJsonSchema,
        501: errorJsonSchema,
        502: errorJsonSchema,
        503: errorJsonSchema,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = embeddingsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", {
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }

    const auth = authorizeEmbeddingsInput(request.ctx, parsed.data);
    if (!auth.ok) {
      return sendError(reply, auth.status, auth.code, auth.details, auth.message);
    }

    const rawKey = request.headers["idempotency-key"];
    const idempotencyKey =
      typeof rawKey === "string" && rawKey.trim() && rawKey.length <= 256
        ? rawKey.trim()
        : undefined;

    // Per-tenant policy resolution (MULTI_TENANT_POLICY), same as chat.
    const rdeps: EmbeddingsRouteDeps = deps.tenantPolicy
      ? { ...deps, ...(await deps.tenantPolicy.resolve(request.ctx.tenantId)) }
      : deps;

    // Fail closed on hierarchical (node-tree) budgets. Embeddings only implement
    // the flat budget path; silently billing the flat counters for a key scoped
    // to a budget node would let embeddings escape the node cap it was meant to
    // enforce. Reject clearly until the hierarchical path is implemented.
    if (useHierarchicalBudgets(rdeps.hierarchicalBudgets, request.ctx.budgetNodeId)) {
      return sendError(
        reply,
        501,
        "not_implemented",
        {},
        "Embeddings do not support hierarchical (node-tree) budgets; use a flat-budget API key",
      );
    }

    // Emergency pause blocks ALL new provider traffic — embeddings included, so
    // it isn't a bypass during an incident (parity with the chat pipeline).
    const pause = await assertAiRequestsNotPaused(rdeps.pool);
    if (pause.paused) {
      return sendError(
        reply,
        503,
        "ai_requests_paused",
        { reason: pause.reason ?? "emergency pause" },
        "AI requests are temporarily paused",
      );
    }

    const svc: EmbeddingsDeps = {
      config: rdeps.config,
      pool: rdeps.pool,
      litellm: rdeps.litellm,
      observability: rdeps.observability,
      policyMeta: rdeps.policyMeta
        ? { ...rdeps.policyMeta, tenantId: request.ctx.tenantId }
        : (request.ctx.tenantId ? { tenantId: request.ctx.tenantId } : undefined),
      log: request.log,
    };

    const run = () => handleEmbeddings(svc, auth.value);

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
