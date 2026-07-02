import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { sendError } from "../../errors";
import { errorJsonSchema } from "../chat/schemas";
import { authorizeRequestList, authorizeRequestShow } from "./authorize";
import { formatRequestId, getRequestById, listRequests, parseRequestId } from "./repo";
import { requestListJsonSchema, requestListQuerySchema, requestRecordJsonSchema } from "./schemas";

export function registerRequestsRoute(
  app: FastifyInstance,
  pool: Pool,
  opts: { defaultProjectId: string },
): void {
  app.get("/v1/requests", {
    schema: {
      tags: ["requests"],
      description: "List recent request audit records (metadata only — no prompt content).",
      querystring: {
        type: "object",
        properties: {
          userId: { type: "string" },
          feature: { type: "string" },
          userType: { type: "string" },
          status: { type: "string", enum: ["completed", "blocked", "safety_blocked", "error"] },
          reasonCode: { type: "string" },
          since: { type: "string", description: "e.g. 24h, 7d, or ISO-8601" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          projectId: { type: "string" },
        },
      },
      response: {
        200: requestListJsonSchema,
        400: errorJsonSchema,
        401: errorJsonSchema,
        403: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = requestListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", {
        detail: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }

    const auth = authorizeRequestList(request.ctx, parsed.data, opts.defaultProjectId);
    if (!auth.ok) {
      return sendError(reply, auth.status, auth.code, {}, auth.message);
    }

    try {
      const items = await listRequests(pool, auth.value);
      return reply.send({ items, limit: auth.value.limit ?? 50 });
    } catch (err) {
      if (err instanceof Error && err.message === "invalid_since") {
        return sendError(reply, 400, "invalid_request", { detail: "invalid since parameter" });
      }
      throw err;
    }
  });

  app.get("/v1/requests/:id", {
    schema: {
      tags: ["requests"],
      description: "Get one request audit record by id (req_<number>). Metadata only.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      response: {
        200: requestRecordJsonSchema,
        400: errorJsonSchema,
        401: errorJsonSchema,
        403: errorJsonSchema,
        404: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const auth = authorizeRequestShow(request.ctx);
    if (!auth.ok) {
      return sendError(reply, auth.status, auth.code, {}, auth.message);
    }

    const rawId = (request.params as { id: string }).id;
    let numericId: number;
    try {
      numericId = parseRequestId(rawId);
    } catch {
      return sendError(reply, 400, "invalid_request", { detail: "invalid request id" });
    }

    const record = await getRequestById(pool, numericId, {
      projectScope: auth.projectScope,
      tenantScope: auth.tenantScope,
    });
    if (!record) {
      return sendError(reply, 404, "not_found", {}, "Request not found");
    }

    if (
      request.ctx.allowedUserIds?.length &&
      record.userId &&
      !request.ctx.allowedUserIds.includes(record.userId)
    ) {
      return sendError(reply, 403, "user_forbidden", {}, "API key is not permitted for this user");
    }

    return reply.send(record);
  });
}

export { formatRequestId };
