import { PolicyConfigError } from "@modelgov/policy-engine";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
  reviewConfigVersion,
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
  /**
   * Two-person rule: when true, saved versions are `proposed` and must be
   * approved by a different operator before they can be activated.
   */
  approvalRequired?: boolean;
  /**
   * Fingerprint of the boot config's non-hot-reloadable fields (pricing, retry,
   * injection model, billing). When set AND hot reload is on (onActivated
   * defined), activating a version that changes any of these is refused so it
   * can't half-apply. See frozenPolicyFieldsFingerprint.
   */
  frozenFieldsFingerprint?: string;
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
        approvalRequired: deps.approvalRequired,
      }, (saved) => ({
        actor: request.ctx.apiKeyName ?? "unknown",
        action: "policy.save",
        target: saved.id,
        tenantId: request.ctx.tenantId,
        metadata: { checksum: saved.checksum, note: saved.note, status: saved.status },
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
      const { parseConfig } = await import("@modelgov/policy-engine");
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
      description: "Activate a stored policy version (rollback = activate a prior id). Requires policy:write. When approval is required, only an approved version can be activated (409 otherwise).",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      response: { 200: { type: "object", additionalProperties: true }, 401: errorJsonSchema, 403: errorJsonSchema, 404: errorJsonSchema, 409: errorJsonSchema },
    },
  }, async (request, reply) => {
    const auth = requirePerm(request.ctx, "policy:write");
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const id = (request.params as { id: string }).id;
    if (!UUID_OR_INT.test(id)) return sendError(reply, 404, "not_found", {}, "Version not found");
    let result;
    try {
      result = await activateConfigVersion(
        pool,
        id,
        request.ctx.tenantId ?? "default",
        (activated) => ({
          actor: request.ctx.apiKeyName ?? "unknown",
          action: "policy.activate",
          target: activated.id,
          tenantId: request.ctx.tenantId,
          metadata: { checksum: activated.checksum },
        }),
        {
          // Enforce a real review (not just `approved` status) when the two-person
          // rule is on, so a pre-approval-era draft can't be activated solo.
          requireReviewed: deps.approvalRequired,
          // Only guard boot-only fields when hot reload is active (onActivated set):
          // on the restart path a restart applies them, so no guard is needed.
          frozenGuard:
            deps.onActivated && deps.frozenFieldsFingerprint
              ? { bootFingerprint: deps.frozenFieldsFingerprint }
              : undefined,
        },
      );
    } catch (err) {
      if (err instanceof PolicyConfigError) {
        return sendError(reply, 400, "invalid_config", { detail: err.message }, err.message);
      }
      throw err;
    }
    if (!result.ok) {
      if (result.reason === "not_approved") {
        return sendError(reply, 409, "not_approved", {}, "Version must be approved before it can be activated");
      }
      if (result.reason === "not_reviewed") {
        return sendError(
          reply,
          409,
          "not_reviewed",
          {},
          "Approval is required: this version predates the two-person rule and was never reviewed. Re-save it as a new proposal and have a different operator approve it.",
        );
      }
      if (result.reason === "conflict") {
        return sendError(reply, 409, "activation_conflict", {}, "Another activation is in progress; retry");
      }
      if (result.reason === "requires_restart") {
        return sendError(
          reply,
          409,
          "requires_restart",
          {},
          "This version changes a boot-only field (pricing, retry, injection model, or billing) that hot reload cannot apply safely. Deploy it with a rolling restart, or disable POLICY_HOT_RELOAD, or revert those fields.",
        );
      }
      return sendError(reply, 404, "not_found", {}, "Version not found");
    }
    const record = result.record;
    const tenantId = request.ctx.tenantId ?? "default";
    // Evict this replica's cached policy so the change applies without a restart.
    // Other replicas are invalidated via LISTEN/NOTIFY (fired transactionally by
    // activateConfigVersion); this local call just avoids the notify round-trip.
    deps.onActivated?.(tenantId);
    const note = deps.onActivated
      ? "activated — applied immediately across replicas (hot reload)"
      : "activated — rolling restart applies it across replicas";
    return reply.send({ ...record, note });
  });

  // Two-person rule: approve/reject a proposed version. Distinct from
  // policy:write (author) so no single operator can both propose and approve.
  const reviewRoute = (decision: "approved" | "rejected") =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = requirePerm(request.ctx, "policy:approve");
      if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

      const id = (request.params as { id: string }).id;
      if (!UUID_OR_INT.test(id)) return sendError(reply, 404, "not_found", {}, "Version not found");
      const result = await reviewConfigVersion(
        pool,
        { id, decision, reviewer: request.ctx.apiKeyName ?? "unknown", tenantId: request.ctx.tenantId },
        (reviewed) => ({
          actor: request.ctx.apiKeyName ?? "unknown",
          action: decision === "approved" ? "policy.approve" : "policy.reject",
          target: reviewed.id,
          tenantId: request.ctx.tenantId,
          metadata: { checksum: reviewed.checksum, proposedBy: reviewed.proposedBy },
        }),
      );
      if (!result.ok) {
        if (result.reason === "self_approval") {
          return sendError(reply, 403, "self_approval", {}, "A version must be approved by a different operator than the one who proposed it");
        }
        if (result.reason === "not_proposed") {
          return sendError(reply, 409, "not_proposed", {}, "Only a proposed version can be reviewed");
        }
        return sendError(reply, 404, "not_found", {}, "Version not found");
      }
      return reply.send(result.record);
    };

  app.post("/v1/admin/policy/versions/:id/approve", {
    schema: {
      tags: ["admin"],
      description: "Approve a proposed policy version so it can be activated. Requires policy:approve, and the approver must differ from the proposer (403 self_approval).",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      response: { 200: { type: "object", additionalProperties: true }, 401: errorJsonSchema, 403: errorJsonSchema, 404: errorJsonSchema, 409: errorJsonSchema },
    },
  }, reviewRoute("approved"));

  app.post("/v1/admin/policy/versions/:id/reject", {
    schema: {
      tags: ["admin"],
      description: "Reject a proposed policy version. Requires policy:approve.",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      response: { 200: { type: "object", additionalProperties: true }, 401: errorJsonSchema, 403: errorJsonSchema, 404: errorJsonSchema, 409: errorJsonSchema },
    },
  }, reviewRoute("rejected"));
}
