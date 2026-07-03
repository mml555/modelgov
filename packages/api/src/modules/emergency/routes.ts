import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { sendError } from "../../errors";
import { getEmergencyPause, setEmergencyPause } from "../emergency/repo";

const pauseBodySchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});

export function registerEmergencyRoutes(app: FastifyInstance, pool: Pool): void {
  app.get("/v1/admin/emergency/status", {
    schema: {
      tags: ["admin"],
      description: "Current emergency pause state for AI requests.",
    },
  }, async (request, reply) => {
    if (!request.ctx.permissions?.includes("policy:read")) {
      return sendError(reply, 403, "forbidden", {}, "API key is not permitted to read emergency status");
    }
    return reply.send(await getEmergencyPause(pool));
  });

  app.post("/v1/admin/emergency/pause", {
    schema: {
      tags: ["admin"],
      description: "Block all new AI requests until resumed. Requires policy:write.",
    },
  }, async (request, reply) => {
    if (!request.ctx.permissions?.includes("policy:write")) {
      return sendError(reply, 403, "forbidden", {}, "API key is not permitted to pause AI requests");
    }
    const parsed = pauseBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", {
        detail: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }
    const state = await setEmergencyPause(pool, {
      paused: true,
      reason: parsed.data.reason,
      pausedBy: request.ctx.apiKeyName ?? "unknown",
    });
    return reply.send(state);
  });

  app.post("/v1/admin/emergency/resume", {
    schema: {
      tags: ["admin"],
      description: "Resume AI requests after an emergency pause. Requires policy:write.",
    },
  }, async (request, reply) => {
    if (!request.ctx.permissions?.includes("policy:write")) {
      return sendError(reply, 403, "forbidden", {}, "API key is not permitted to resume AI requests");
    }
    const state = await setEmergencyPause(pool, {
      paused: false,
      pausedBy: request.ctx.apiKeyName ?? "unknown",
    });
    return reply.send(state);
  });
}

export async function assertAiRequestsNotPaused(pool: Pool): Promise<{
  paused: boolean;
  reason?: string;
}> {
  const state = await getEmergencyPause(pool);
  if (!state.paused) return { paused: false };
  return { paused: true, reason: state.reason };
}
