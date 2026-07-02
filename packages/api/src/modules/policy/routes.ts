import { PolicyConfigError } from "@ai-guard/policy-engine";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { sendError } from "../../errors";
import type { RequestContext } from "../../plugins/requestContext";
import { errorJsonSchema } from "../chat/schemas";
import {
  activateConfigVersion,
  getActiveConfigVersion,
  getConfigVersionYaml,
  listConfigVersions,
  saveConfigVersion,
} from "./repo";
import { diffConfigYaml } from "./diff";

const UUID_OR_INT = /^\d+$/;
const saveBodySchema = z.object({ yaml: z.string().min(1), note: z.string().max(500).optional() });

export interface PolicyRouteDeps {
  /**
   * Called after a version is activated, with the tenant whose active version
   * changed, so a per-tenant policy cache can evict it (restart-free activation).
   */
  onActivated?: (tenantId: string) => void;
}

function requirePerm(ctx: RequestContext, perm: string) {
  if (!ctx.permissions?.includes(perm)) {
    return { ok: false as const, status: 403, code: "forbidden", message: `API key is not permitted (${perm})` };
  }
  return { ok: true as const };
}

export function registerPolicyRoutes(
  app: FastifyInstance,
  pool: Pool,
  deps: PolicyRouteDeps = {},
): void {
  app.get("/v1/admin/policy/versions", {
    schema: {
      tags: ["admin"],
      description: "List stored policy versions (metadata). Requires policy:read.",
      response: { 200: { type: "object", additionalProperties: true }, 401: errorJsonSchema, 403: errorJsonSchema },
    },
  }, async (request, reply) => {
    const auth = requirePerm(request.ctx, "policy:read");
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);
    return reply.send({ items: await listConfigVersions(pool, request.ctx.tenantId) });
  });

  app.get("/v1/admin/policy/active", {
    schema: {
      tags: ["admin"],
      description: "Get the active policy version's metadata. Requires policy:read.",
      response: { 200: { type: "object", additionalProperties: true }, 401: errorJsonSchema, 403: errorJsonSchema, 404: errorJsonSchema },
    },
  }, async (request, reply) => {
    const auth = requirePerm(request.ctx, "policy:read");
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);
    const active = await getActiveConfigVersion(pool, request.ctx.tenantId);
    if (!active) return sendError(reply, 404, "not_found", {}, "No active policy version");
    return reply.send(active.record);
  });

  app.post("/v1/admin/policy/versions", {
    schema: {
      tags: ["admin"],
      description: "Validate and store a new (inactive) policy version. Requires policy:write.",
      response: { 201: { type: "object", additionalProperties: true }, 400: errorJsonSchema, 401: errorJsonSchema, 403: errorJsonSchema, 500: errorJsonSchema },
    },
  }, async (request, reply) => {
    const auth = requirePerm(request.ctx, "policy:write");
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const parsed = saveBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", {
        detail: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    let record;
    try {
      record = await saveConfigVersion(pool, {
        yaml: parsed.data.yaml,
        note: parsed.data.note,
        author: request.ctx.apiKeyName,
        tenantId: request.ctx.tenantId,
      }, (saved) => ({
        actor: request.ctx.apiKeyName ?? "unknown",
        action: "policy.save",
        target: saved.id,
        tenantId: request.ctx.tenantId,
        metadata: { checksum: saved.checksum, note: saved.note },
      }));
    } catch (err) {
      if (err instanceof PolicyConfigError) {
        return sendError(reply, 400, "invalid_config", { detail: err.message }, err.message);
      }
      throw err;
    }
    return reply.code(201).send(record);
  });

  app.post("/v1/admin/policy/preview", {
    schema: {
      tags: ["admin"],
      description: "Validate a proposed policy and diff it against the active version WITHOUT saving. Requires policy:read.",
      response: { 200: { type: "object", additionalProperties: true }, 400: errorJsonSchema, 401: errorJsonSchema, 403: errorJsonSchema },
    },
  }, async (request, reply) => {
    const auth = requirePerm(request.ctx, "policy:read");
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const parsed = saveBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", { detail: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    try {
      // Reuse the store validator by parsing (no write).
      const { parseConfig } = await import("@ai-guard/policy-engine");
      parseConfig(parsed.data.yaml);
    } catch (err) {
      if (err instanceof PolicyConfigError) {
        return reply.send({ valid: false, error: err.message });
      }
      throw err;
    }
    const active = await getActiveConfigVersion(pool, request.ctx.tenantId);
    const diff = active ? diffConfigYaml(active.yaml, parsed.data.yaml) : [];
    return reply.send({ valid: true, activeVersion: active?.record.id ?? null, diff });
  });

  app.get("/v1/admin/policy/versions/:id/diff", {
    schema: {
      tags: ["admin"],
      description: "Diff a stored version against another (?against=<id>) or the active version. Requires policy:read.",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      querystring: { type: "object", properties: { against: { type: "string" } } },
      response: { 200: { type: "object", additionalProperties: true }, 401: errorJsonSchema, 403: errorJsonSchema, 404: errorJsonSchema, 500: errorJsonSchema },
    },
  }, async (request, reply) => {
    const auth = requirePerm(request.ctx, "policy:read");
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const id = (request.params as { id: string }).id;
    if (!UUID_OR_INT.test(id)) return sendError(reply, 404, "not_found", {}, "Version not found");
    const toYaml = await getConfigVersionYaml(pool, id, request.ctx.tenantId);
    if (!toYaml) return sendError(reply, 404, "not_found", {}, "Version not found");

    const againstId = (request.query as { against?: string }).against;
    let fromYaml: string | null;
    let fromId: string | null;
    if (againstId) {
      if (!UUID_OR_INT.test(againstId)) return sendError(reply, 404, "not_found", {}, "Comparison version not found");
      fromYaml = await getConfigVersionYaml(pool, againstId, request.ctx.tenantId);
      fromId = againstId;
    } else {
      const active = await getActiveConfigVersion(pool, request.ctx.tenantId);
      fromYaml = active?.yaml ?? null;
      fromId = active?.record.id ?? null;
    }
    if (!fromYaml) return sendError(reply, 404, "not_found", {}, "Comparison version not found");
    return reply.send({ from: fromId, to: id, diff: diffConfigYaml(fromYaml, toYaml) });
  });

  app.post("/v1/admin/policy/versions/:id/activate", {
    schema: {
      tags: ["admin"],
      description: "Activate a stored policy version (rollback = activate a prior id). Requires policy:write.",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      response: { 200: { type: "object", additionalProperties: true }, 401: errorJsonSchema, 403: errorJsonSchema, 404: errorJsonSchema },
    },
  }, async (request, reply) => {
    const auth = requirePerm(request.ctx, "policy:write");
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const id = (request.params as { id: string }).id;
    if (!UUID_OR_INT.test(id)) return sendError(reply, 404, "not_found", {}, "Version not found");
    let record;
    try {
      record = await activateConfigVersion(pool, id, request.ctx.tenantId ?? "default", (activated) => ({
        actor: request.ctx.apiKeyName ?? "unknown",
        action: "policy.activate",
        target: activated.id,
        tenantId: request.ctx.tenantId,
        metadata: { checksum: activated.checksum },
      }));
    } catch (err) {
      if (err instanceof PolicyConfigError) {
        return sendError(reply, 400, "invalid_config", { detail: err.message }, err.message);
      }
      throw err;
    }
    if (!record) return sendError(reply, 404, "not_found", {}, "Version not found");
    const tenantId = request.ctx.tenantId ?? "default";
    // Evict this tenant's cached policy so the change applies without a restart
    // when per-tenant resolution is on (no-op otherwise).
    deps.onActivated?.(tenantId);
    const note = deps.onActivated
      ? "activated — applied within the policy cache TTL across replicas"
      : "activated — rolling restart applies it across replicas";
    return reply.send({ ...record, note });
  });
}
