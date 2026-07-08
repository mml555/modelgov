import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../../db/pool";
import { sendError } from "../../errors";
import type { RequestContext } from "../../plugins/requestContext";
import { resolveControlPlaneTenant } from "../authz/scope";
import { appendAuditInTransaction } from "../audit/repo";
import { errorJsonSchema } from "../chat/schemas";
import {
  createApiKey,
  getApiKeyById,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
} from "./repo";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createKeyBodySchema = z.object({
  name: z.string().min(1).max(200),
  permissions: z.array(z.string().min(1)).max(32).optional(),
  projectId: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
  allowedUserTypes: z.array(z.string().min(1)).max(64).optional(),
  allowedUserIds: z.array(z.string().min(1)).max(1000).optional(),
  tenantId: z.string().min(1).optional(),
  budgetNodeId: z.string().min(1).optional(),
  expiresAt: z.string().datetime().optional(),
});

const keyRecordJsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    keyPrefix: { type: "string" },
    permissions: { type: "array", items: { type: "string" } },
    projectId: { type: "string" },
    environment: { type: "string" },
    allowedUserTypes: { type: "array", items: { type: "string" } },
    allowedUserIds: { type: "array", items: { type: "string" } },
    tenantId: { type: "string" },
    budgetNodeId: { type: "string" },
    createdAt: { type: "string" },
    createdBy: { type: "string" },
    expiresAt: { type: "string" },
    revokedAt: { type: "string" },
    lastUsedAt: { type: "string" },
  },
} as const;

const issuedKeyJsonSchema = {
  type: "object",
  properties: {
    ...keyRecordJsonSchema.properties,
    secret: {
      type: "string",
      description: "Plaintext secret — shown once, never retrievable again.",
    },
  },
} as const;

/** Deps let the routes invalidate the auth cache the moment a key changes. */
export interface KeysRouteDeps {
  onKeysChanged?: () => void;
}

function requireKeysAdmin(
  ctx: RequestContext,
): { ok: true } | { ok: false; status: number; code: string; message: string } {
  if (!ctx.permissions?.includes("keys:admin")) {
    return {
      ok: false,
      status: 403,
      code: "forbidden",
      message: "API key is not permitted to manage keys",
    };
  }
  return { ok: true };
}

/**
 * Validate a key-creation request against the caller's authority:
 *  - Tenant: a tenant-scoped admin (ctx.tenantId set) may only mint keys for its
 *    OWN tenant; a body tenantId naming another tenant is rejected. A root admin
 *    (no tenant) may set any tenant. The effective tenant is returned.
 *  - Permission ceiling: the new key's permissions must be a subset of the
 *    caller's, so a key-admin can't escalate a minted key past its own grants
 *    (e.g. hand out data:erase or policy:write it does not itself hold).
 */
function authorizeKeyCreation(
  ctx: RequestContext,
  body: { tenantId?: string; permissions?: string[] },
):
  | { ok: true; tenantId?: string }
  | { ok: false; status: number; code: string; message: string } {
  // An unbound admin without tenant:switch is confined to the default partition,
  // so it can only mint keys there — not plant a key in an arbitrary tenant.
  const callerTenant = resolveControlPlaneTenant(ctx);
  if (callerTenant !== undefined && body.tenantId !== undefined && body.tenantId !== callerTenant) {
    return {
      ok: false,
      status: 403,
      code: "forbidden",
      message: "cannot create a key for another tenant",
    };
  }
  // chat:create is the only data-plane permission; a key-admin provisions chat
  // keys as its job, so granting it never requires the admin to hold it. Every
  // OTHER permission is control/observability plane (keys:admin, policy:*,
  // data:erase, audit:read, usage:read, requests:read) and CANNOT be granted
  // beyond what the caller itself holds — that is the escalation the ceiling
  // exists to stop.
  const callerPerms = new Set(ctx.permissions ?? []);
  const requested = body.permissions ?? ["chat:create"];
  const escalated = requested.filter((p) => p !== "chat:create" && !callerPerms.has(p));
  if (escalated.length > 0) {
    return {
      ok: false,
      status: 403,
      code: "forbidden",
      message: `cannot grant permissions the caller does not hold: ${escalated.join(", ")}`,
    };
  }
  return { ok: true, tenantId: callerTenant ?? body.tenantId };
}

export function registerKeysRoutes(
  app: FastifyInstance,
  pool: Pool,
  deps: KeysRouteDeps = {},
): void {
  app.post("/v1/admin/keys", {
    schema: {
      tags: ["admin"],
      description:
        "Issue a new API key. The plaintext secret is returned once; only its hash is stored.",
      response: {
        201: issuedKeyJsonSchema,
        400: errorJsonSchema,
        401: errorJsonSchema,
        403: errorJsonSchema,
        500: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const auth = requireKeysAdmin(request.ctx);
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const parsed = createKeyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", {
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }

    const authz = authorizeKeyCreation(request.ctx, parsed.data);
    if (!authz.ok) return sendError(reply, authz.status, authz.code, {}, authz.message);

    const issued = await withTransaction(pool, async (client) => {
      const { record, secret } = await createApiKey(client, {
        ...parsed.data,
        tenantId: authz.tenantId,
        createdBy: request.ctx.principalName,
      });
      // Audit from `record` (metadata only) — never from an object carrying the
      // plaintext secret, so the audit row hash can't pull in the credential.
      await appendAuditInTransaction(client, {
        actor: request.ctx.principalName ?? "unknown",
        action: "key.create",
        target: record.id,
        tenantId: request.ctx.tenantId,
        metadata: {
          name: record.name,
          permissions: record.permissions,
          projectId: record.projectId,
        },
      });
      return { ...record, secret };
    });
    deps.onKeysChanged?.();
    return reply.code(201).send(issued);
  });

  app.get("/v1/admin/keys", {
    schema: {
      tags: ["admin"],
      description: "List API keys (metadata only — never secrets or hashes).",
      querystring: {
        type: "object",
        properties: {
          includeRevoked: { type: "boolean" },
          projectId: { type: "string" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: { items: { type: "array", items: keyRecordJsonSchema } },
        },
        401: errorJsonSchema,
        403: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const auth = requireKeysAdmin(request.ctx);
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const query = request.query as { includeRevoked?: boolean; projectId?: string };
    const items = await listApiKeys(pool, {
      includeRevoked: query.includeRevoked === true,
      projectId: query.projectId,
      tenantId: resolveControlPlaneTenant(request.ctx),
    });
    return reply.send({ items });
  });

  app.get("/v1/admin/keys/:id", {
    schema: {
      tags: ["admin"],
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      response: {
        200: keyRecordJsonSchema,
        401: errorJsonSchema,
        403: errorJsonSchema,
        404: errorJsonSchema,
        500: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const auth = requireKeysAdmin(request.ctx);
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const id = (request.params as { id: string }).id;
    if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", {}, "Key not found");
    const record = await getApiKeyById(pool, id, resolveControlPlaneTenant(request.ctx));
    if (!record) return sendError(reply, 404, "not_found", {}, "Key not found");
    return reply.send(record);
  });

  app.post("/v1/admin/keys/:id/rotate", {
    schema: {
      tags: ["admin"],
      description: "Mint a new secret for an existing key; the old secret stops working immediately.",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      response: {
        200: issuedKeyJsonSchema,
        401: errorJsonSchema,
        403: errorJsonSchema,
        404: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const auth = requireKeysAdmin(request.ctx);
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const id = (request.params as { id: string }).id;
    if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", {}, "Key not found");
    const issued = await withTransaction(pool, async (client) => {
      const rotated = await rotateApiKey(client, id, resolveControlPlaneTenant(request.ctx));
      if (!rotated) return null;
      await appendAuditInTransaction(client, {
        actor: request.ctx.principalName ?? "unknown",
        action: "key.rotate",
        target: id,
        tenantId: request.ctx.tenantId,
      });
      return { ...rotated.record, secret: rotated.secret };
    });
    if (!issued) return sendError(reply, 404, "not_found", {}, "Key not found or revoked");
    deps.onKeysChanged?.();
    return reply.send(issued);
  });

  app.post("/v1/admin/keys/:id/revoke", {
    schema: {
      tags: ["admin"],
      description: "Revoke a key. Idempotent.",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      response: {
        200: { type: "object", properties: { id: { type: "string" }, revoked: { type: "boolean" } } },
        401: errorJsonSchema,
        403: errorJsonSchema,
        404: errorJsonSchema,
        500: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const auth = requireKeysAdmin(request.ctx);
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const id = (request.params as { id: string }).id;
    if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", {}, "Key not found");
    const ok = await withTransaction(pool, async (client) => {
      const revoked = await revokeApiKey(client, id, resolveControlPlaneTenant(request.ctx));
      if (!revoked) return false;
      await appendAuditInTransaction(client, {
        actor: request.ctx.principalName ?? "unknown",
        action: "key.revoke",
        target: id,
        tenantId: request.ctx.tenantId,
      });
      return true;
    });
    if (!ok) return sendError(reply, 404, "not_found", {}, "Key not found");
    deps.onKeysChanged?.();
    return reply.send({ id, revoked: true });
  });
}
