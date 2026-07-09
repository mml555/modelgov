import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { sendError } from "../../errors";
import { errorJsonSchema } from "../chat/schemas";
import { checkEnvironmentScope } from "../authz/scope";
import { authorizeUsageQuery, authorizeUsageSummary } from "./authorizeUsage";
import { getUsageSummary } from "./service";
import { getUsageSummaryReport } from "./summaryReport";
import { getTransactionRollup } from "./transactions";
import { logRequest } from "./auditLogRepo";
import type { TenantPolicyResolver } from "../policy/tenantResolver";

const querySchema = z.object({
  userId: z.string().min(1).optional(),
  feature: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});

const summaryQuerySchema = z.object({
  feature: z.string().min(1).optional(),
  userType: z.string().min(1).optional(),
  since: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});

const transactionsQuerySchema = z.object({
  since: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  projectId: z.string().min(1).optional(),
});

const externalCostBodySchema = z.object({
  /** Transaction to attribute the cost to; defaults to the x-request-id. */
  correlationId: z.string().min(1).max(128).optional(),
  /** Non-LLM cost source, must be on the EXTERNAL_COST_SOURCES allowlist. */
  source: z.string().min(1).max(64),
  /** Required so external cost slots into the same feature dimension as LLM cost. */
  feature: z.string().min(1).max(128),
  userType: z.string().min(1).max(128).optional(),
  costUsd: z.number().nonnegative().finite(),
  quantity: z.number().positive().finite().optional(),
  unit: z.string().min(1).max(32).optional(),
  projectId: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const externalCostBodyJsonSchema = {
  type: "object",
  required: ["source", "feature", "costUsd"],
  additionalProperties: false,
  properties: {
    correlationId: { type: "string", maxLength: 128 },
    source: { type: "string", minLength: 1, maxLength: 64 },
    feature: { type: "string", minLength: 1, maxLength: 128 },
    userType: { type: "string", minLength: 1, maxLength: 128 },
    costUsd: { type: "number", minimum: 0 },
    quantity: { type: "number", exclusiveMinimum: 0 },
    unit: { type: "string", minLength: 1, maxLength: 32 },
    projectId: { type: "string" },
    environment: { type: "string" },
    metadata: { type: "object", additionalProperties: true },
  },
} as const;

const externalCostResultJsonSchema = {
  type: "object",
  required: ["id", "correlationId"],
  properties: {
    id: { type: "string" },
    correlationId: { type: "string" },
  },
} as const;

const transactionsJsonSchema = {
  type: "object",
  required: ["since", "limit", "transactions"],
  properties: {
    since: { type: "string" },
    limit: { type: "integer" },
    transactions: {
      type: "array",
      items: {
        type: "object",
        required: [
          "correlationId",
          "requests",
          "externalEvents",
          "actualCostUsd",
          "llmCostUsd",
          "externalCostUsd",
          "estimatedCostUsd",
          "firstSeen",
          "lastSeen",
        ],
        properties: {
          correlationId: { type: "string" },
          requests: { type: "integer" },
          externalEvents: { type: "integer" },
          actualCostUsd: { type: "number" },
          llmCostUsd: { type: "number" },
          externalCostUsd: { type: "number" },
          estimatedCostUsd: { type: "number" },
          firstSeen: { type: "string" },
          lastSeen: { type: "string" },
        },
      },
    },
  },
} as const;

export function registerUsageRoute(
  app: FastifyInstance,
  pool: Pool,
  opts: {
    defaultProjectId: string;
    /** Static global monthly cap (boot config) — used when no resolver is set. */
    globalMonthlyCapUsd?: number;
    /** When present, the cap follows the effective tenant's active policy
     *  version (hot reload / per-tenant), not the static boot cap. */
    tenantPolicy?: TenantPolicyResolver;
    /** External (non-LLM) cost ingestion config; empty sources disables the endpoint. */
    externalCost?: { sources: readonly string[]; maxUsd: number };
  },
): void {
  app.get("/v1/usage", {
    schema: {
      tags: ["usage"],
      description: "Current budget counters for a user and/or feature.",
      querystring: {
        type: "object",
        properties: {
          userId: { type: "string" },
          feature: { type: "string" },
          projectId: { type: "string" },
        },
      },
    },
  }, async (request, reply) => {
    if (!request.ctx.permissions?.includes("usage:read")) {
      return sendError(
        reply,
        403,
        "forbidden",
        {},
        "API key is not permitted to read usage",
      );
    }

    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", {
        detail: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }

    const auth = authorizeUsageQuery(request.ctx, parsed.data, opts.defaultProjectId);
    if (!auth.ok) {
      return sendError(reply, auth.status, auth.code, {}, auth.message);
    }

    // Prefer the effective tenant's active-policy cap (hot reload / per-tenant);
    // fall back to the static boot cap when no resolver is wired. Resolving the
    // cap reads the policy store — a fault there must not fail this endpoint (it
    // is otherwise independent of the store), so degrade to the boot cap.
    let capUsd = opts.globalMonthlyCapUsd;
    if (opts.tenantPolicy) {
      try {
        const resolved = await opts.tenantPolicy.resolve(request.ctx.tenantId);
        capUsd = resolved.config.budgets.global?.monthlyUsd;
      } catch (err) {
        request.log.warn({ err }, "usage: failed to resolve tenant policy cap; using boot cap");
      }
    }
    const summary = await getUsageSummary(pool, auth.value, { globalMonthlyCapUsd: capUsd });
    return reply.send(summary);
  });

  app.get("/v1/usage/summary", {
    schema: {
      tags: ["usage"],
      description: "Aggregated request/cost summary from audit logs.",
      querystring: {
        type: "object",
        properties: {
          feature: { type: "string" },
          userType: { type: "string" },
          since: { type: "string", description: "e.g. 24h, 7d, or ISO-8601" },
          projectId: { type: "string" },
        },
      },
    },
  }, async (request, reply) => {
    if (!request.ctx.permissions?.includes("usage:read")) {
      return sendError(
        reply,
        403,
        "forbidden",
        {},
        "API key is not permitted to read usage",
      );
    }

    const parsed = summaryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", {
        detail: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }

    const auth = authorizeUsageSummary(request.ctx, parsed.data, opts.defaultProjectId);
    if (!auth.ok) {
      return sendError(reply, auth.status, auth.code, {}, auth.message);
    }

    try {
      const report = await getUsageSummaryReport(pool, {
        feature: parsed.data.feature,
        userType: parsed.data.userType,
        since: parsed.data.since,
        projectScope: auth.projectScope,
        tenantScope: auth.tenantScope,
      });
      return reply.send(report);
    } catch (err) {
      if (err instanceof Error && err.message === "invalid_since") {
        return sendError(reply, 400, "invalid_request", { detail: "invalid since parameter" });
      }
      throw err;
    }
  });

  app.get("/v1/usage/transactions", {
    schema: {
      tags: ["usage"],
      description:
        "Per-transaction cost rollup (grouped by correlationId), top-N by cost. Combines LLM and externally-ingested cost, broken out.",
      querystring: {
        type: "object",
        properties: {
          since: { type: "string", description: "e.g. 24h, 7d, or ISO-8601 (default 24h)" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          projectId: { type: "string" },
        },
      },
      response: {
        200: transactionsJsonSchema,
        400: errorJsonSchema,
        401: errorJsonSchema,
        403: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    if (!request.ctx.permissions?.includes("usage:read")) {
      return sendError(reply, 403, "forbidden", {}, "API key is not permitted to read usage");
    }

    const parsed = transactionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", {
        detail: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }

    const auth = authorizeUsageSummary(request.ctx, parsed.data, opts.defaultProjectId);
    if (!auth.ok) {
      return sendError(reply, auth.status, auth.code, {}, auth.message);
    }

    try {
      const report = await getTransactionRollup(pool, {
        since: parsed.data.since,
        limit: parsed.data.limit,
        projectScope: auth.projectScope,
        tenantScope: auth.tenantScope,
      });
      return reply.send(report);
    } catch (err) {
      if (err instanceof Error && err.message === "invalid_since") {
        return sendError(reply, 400, "invalid_request", { detail: "invalid since parameter" });
      }
      throw err;
    }
  });

  app.post("/v1/usage/external", {
    schema: {
      tags: ["usage"],
      description:
        "Record externally-tracked non-LLM cost (e.g. Azure Document Intelligence) against a transaction. Recording only — not budget-enforced. Requires usage:write.",
      body: externalCostBodyJsonSchema,
      response: {
        201: externalCostResultJsonSchema,
        400: errorJsonSchema,
        401: errorJsonSchema,
        403: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    if (!request.ctx.permissions?.includes("usage:write")) {
      return sendError(reply, 403, "forbidden", {}, "API key is not permitted to write usage");
    }

    // Configuring EXTERNAL_COST_SOURCES is what enables the endpoint; without an
    // allowlist it fails closed so a typo'd source can't mint a phantom bucket.
    const cfg = opts.externalCost;
    if (!cfg || cfg.sources.length === 0) {
      return sendError(
        reply,
        400,
        "external_cost_disabled",
        {},
        "External cost ingestion is not configured (set EXTERNAL_COST_SOURCES)",
      );
    }

    const parsed = externalCostBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", {
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const body = parsed.data;

    if (!cfg.sources.includes(body.source)) {
      return sendError(reply, 400, "invalid_request", {
        detail: `source '${body.source}' is not in the allowlist (EXTERNAL_COST_SOURCES)`,
      });
    }
    if (body.costUsd > cfg.maxUsd) {
      return sendError(reply, 400, "invalid_request", {
        detail: `costUsd ${body.costUsd} exceeds EXTERNAL_COST_MAX_USD (${cfg.maxUsd})`,
      });
    }

    // Same project/tenant/userType scoping as the read summary: a bound key can
    // only attribute cost within its own partition.
    const auth = authorizeUsageSummary(
      request.ctx,
      { projectId: body.projectId, userType: body.userType },
      opts.defaultProjectId,
    );
    if (!auth.ok) {
      return sendError(reply, auth.status, auth.code, {}, auth.message);
    }
    // authorizeUsageSummary doesn't cover environment; enforce it here so a key
    // scoped to one environment can't tag external cost with another (chat /
    // embeddings / documents all check environment scope).
    const envDenial = checkEnvironmentScope(request.ctx, body.environment);
    if (envDenial) {
      return sendError(reply, envDenial.status, envDenial.code, {}, envDenial.message);
    }

    const correlationId = body.correlationId ?? request.ctx.requestId;
    const hostMetadata = {
      ...(body.metadata ?? {}),
      ...(body.quantity != null ? { externalQuantity: body.quantity } : {}),
      ...(body.unit ? { externalUnit: body.unit } : {}),
    };

    const auditId = await logRequest(pool, {
      tenantId: request.ctx.tenantId,
      projectId: auth.projectScope,
      environment: body.environment,
      userType: body.userType,
      feature: body.feature,
      decision: "external",
      status: "ok",
      // Asserted cost is both the estimate and the actual — there is no separate
      // metered figure to reconcile against.
      estimatedCostUsd: body.costUsd,
      actualCostUsd: body.costUsd,
      resolvedModel: body.source,
      correlationId,
      ...(Object.keys(hostMetadata).length > 0 ? { hostMetadata } : {}),
    });

    return reply.code(201).send({ id: auditId, correlationId });
  });
}
