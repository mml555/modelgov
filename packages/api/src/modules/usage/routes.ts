import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { sendError } from "../../errors";
import { authorizeUsageQuery, authorizeUsageSummary } from "./authorizeUsage";
import { getUsageSummary } from "./service";
import { getUsageSummaryReport } from "./summaryReport";

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

export function registerUsageRoute(
  app: FastifyInstance,
  pool: Pool,
  opts: { defaultProjectId: string },
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

    const summary = await getUsageSummary(pool, auth.value);
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
}
