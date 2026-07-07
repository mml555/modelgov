import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { sendError } from "../../errors";
import type { RequestContext } from "../../plugins/requestContext";
import { errorJsonSchema } from "../chat/schemas";
import { listTenants } from "./repo";

/**
 * `GET /v1/admin/whoami` — the authenticated operator's own identity,
 * permissions, and tenant. Requires only authentication (no specific
 * permission): every principal may read who *they* are. The console uses it to
 * hide/disable actions the operator can't perform — enforcement still lives on
 * each endpoint, so this is a UX affordance, not a security boundary.
 */
export function registerWhoamiRoute(app: FastifyInstance): void {
  app.get("/v1/admin/whoami", {
    schema: {
      tags: ["admin"],
      description: "Return the authenticated operator's identity, permissions, and tenant.",
      response: { 200: { type: "object", additionalProperties: true }, 401: errorJsonSchema },
    },
  }, async (request, reply) => {
    return reply.send({
      name: request.ctx.principalName ?? null,
      permissions: request.ctx.permissions ?? [],
      // The effective tenant for this request (the bound tenant, or the one
      // selected via X-Modelgov-Tenant). `tenantBound` tells the console whether
      // the operator is locked to it or may switch (platform operator).
      tenantId: request.ctx.tenantId ?? null,
      tenantBound: request.ctx.tenantBound ?? false,
    });
  });
}

// Any of these read permissions is enough to enumerate tenant ids (a platform
// operator holding one already sees the underlying data unscoped).
const TENANT_LIST_PERMS = ["usage:read", "requests:read", "policy:read", "audit:read"];

function hasAnyPerm(ctx: RequestContext, perms: readonly string[]): boolean {
  return perms.some((p) => ctx.permissions?.includes(p));
}

/**
 * `GET /v1/admin/tenants` — the tenant ids the operator may switch between.
 * A platform (unbound) operator gets every known tenant; a tenant-bound operator
 * gets only its own (no cross-tenant enumeration). Powers the console switcher.
 */
export function registerTenantsRoute(app: FastifyInstance, pool: Pool): void {
  app.get("/v1/admin/tenants", {
    schema: {
      tags: ["admin"],
      description: "List selectable tenant ids. Platform operators see all; a tenant-bound operator sees only its own. Requires a read permission.",
      response: { 200: { type: "object", additionalProperties: true }, 401: errorJsonSchema, 403: errorJsonSchema },
    },
  }, async (request, reply) => {
    if (!hasAnyPerm(request.ctx, TENANT_LIST_PERMS)) {
      return sendError(reply, 403, "forbidden", {}, "API key is not permitted to list tenants");
    }
    // A bound operator is locked to its tenant — never enumerate others.
    if (request.ctx.tenantBound) {
      return reply.send({ tenants: request.ctx.tenantId ? [request.ctx.tenantId] : [] });
    }
    return reply.send({ tenants: await listTenants(pool) });
  });
}
