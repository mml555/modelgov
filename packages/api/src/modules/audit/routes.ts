import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { sendError } from "../../errors";
import type { RequestContext } from "../../plugins/requestContext";
import { resolveControlPlaneTenant } from "../authz/scope";
import { errorJsonSchema } from "../chat/schemas";
import { listAudit, verifyAuditChain } from "./repo";

function requireAuditRead(
  ctx: RequestContext,
): { ok: true } | { ok: false; status: number; code: string; message: string } {
  if (!ctx.permissions?.includes("audit:read")) {
    return { ok: false, status: 403, code: "forbidden", message: "API key is not permitted to read the audit log" };
  }
  return { ok: true };
}

export function registerAuditRoutes(app: FastifyInstance, pool: Pool): void {
  app.get("/v1/admin/audit", {
    schema: {
      tags: ["admin"],
      description: "Read the tamper-evident admin audit log (requires audit:read).",
      querystring: {
        type: "object",
        properties: {
          action: { type: "string" },
          actor: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
      },
      response: { 200: { type: "object", additionalProperties: true }, 401: errorJsonSchema, 403: errorJsonSchema },
    },
  }, async (request, reply) => {
    const auth = requireAuditRead(request.ctx);
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);
    const q = request.query as { action?: string; actor?: string; limit?: number };
    const items = await listAudit(pool, {
      action: q.action,
      actor: q.actor,
      limit: q.limit,
      // A tenant-scoped admin only sees its own tenant's trail; an unbound admin
      // without tenant:switch is confined to the default partition; only a
      // platform (tenant:switch) operator sees all tenants.
      tenantId: resolveControlPlaneTenant(request.ctx),
    });
    return reply.send({ items });
  });

  app.get("/v1/admin/audit/verify", {
    schema: {
      tags: ["admin"],
      description: "Re-walk the audit hash chain and report whether it is intact.",
      response: { 200: { type: "object", additionalProperties: true }, 401: errorJsonSchema, 403: errorJsonSchema },
    },
  }, async (request, reply) => {
    const auth = requireAuditRead(request.ctx);
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);
    // The hash chain is global (rows across all tenants link into one chain), so
    // verification necessarily walks every row and its result (total row count,
    // the id of any tamper point) reflects other tenants' entries. Restrict it to
    // PLATFORM operators (unbound AND holding tenant:switch) — a tenant-bound
    // admin, or an unbound operator without tenant:switch (confined to the default
    // partition), would otherwise learn cross-tenant metadata. resolveControlPlaneTenant
    // returns undefined only for that platform operator. Tenant-scoped reads still
    // go through GET /v1/admin/audit.
    if (resolveControlPlaneTenant(request.ctx) !== undefined) {
      return sendError(
        reply,
        403,
        "forbidden",
        {},
        "Audit chain verification is a platform operation (the chain spans all tenants)",
      );
    }
    return reply.send(await verifyAuditChain(pool));
  });
}
