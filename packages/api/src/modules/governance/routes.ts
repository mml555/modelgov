import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../../db/pool";
import { sendError } from "../../errors";
import type { RequestContext } from "../../plugins/requestContext";
import { appendAuditInTransaction } from "../audit/repo";
import { errorJsonSchema } from "../chat/schemas";
import { eraseUserData } from "./repo";

const erasureBodySchema = z.object({ userId: z.string().min(1) });

function requireDataErase(
  ctx: RequestContext,
): { ok: true } | { ok: false; status: number; code: string; message: string } {
  if (!ctx.permissions?.includes("data:erase")) {
    return { ok: false, status: 403, code: "forbidden", message: "API key is not permitted to erase user data" };
  }
  return { ok: true };
}

export function registerGovernanceRoutes(
  app: FastifyInstance,
  pool: Pool,
): void {
  app.post("/v1/admin/erasure", {
    schema: {
      tags: ["admin"],
      description: "Erase a user's request-linked data (GDPR/CCPA). Requires data:erase.",
      response: {
        200: { type: "object", additionalProperties: true },
        400: errorJsonSchema,
        401: errorJsonSchema,
        403: errorJsonSchema,
        500: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const auth = requireDataErase(request.ctx);
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const parsed = erasureBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", {
        detail: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }

    const result = await withTransaction(pool, async (client) => {
      const erased = await eraseUserData(client, {
        userId: parsed.data.userId,
        tenantId: request.ctx.tenantId,
      });
      await appendAuditInTransaction(client, {
        actor: request.ctx.principalName ?? "unknown",
        action: "data.erasure",
        target: parsed.data.userId,
        tenantId: request.ctx.tenantId,
        metadata: {
          requestLogs: erased.requestLogs,
          idempotencyKeys: erased.idempotencyKeys,
          reservationLeases: erased.reservationLeases,
        },
      });
      return erased;
    });
    return reply.send({ erased: result });
  });
}
