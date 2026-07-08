import type { FastifyInstance } from "fastify";
import { sendError } from "../../errors";
import { checkHealth, checkProviderHealth, checkReady, type HealthDeps } from "./service";

// Public probes: `security: []` overrides the document's global bearerAuth so
// the generated spec shows them as unauthenticated (matching the auth hook,
// which exempts these paths).
const healthSchema = {
  tags: ["health"],
  security: [] as const,
  description: "Liveness — process is up. Does not touch the database.",
} as const;

const readySchema = {
  tags: ["health"],
  security: [] as const,
  description: "Readiness — dependencies (DB, LiteLLM, Presidio) are reachable.",
} as const;

// Authenticated operator view (requires usage:read) — distinct from the public
// /ready probe. Surfaces LiteLLM's per-model health so operators can see which
// provider/model is down without pulling replicas out of rotation.
const providerHealthSchema = {
  tags: ["admin"],
  description:
    "Per-provider/model health from the LiteLLM proxy. Requires usage:read. Read-only; does not affect readiness.",
  response: {
    200: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ok", "degraded", "fail", "skipped"] },
        models: {
          type: "array",
          items: {
            type: "object",
            properties: {
              model: { type: "string" },
              provider: { type: "string" },
              healthy: { type: "boolean" },
              error: { type: "string" },
            },
            required: ["model", "provider", "healthy"],
          },
        },
      },
      required: ["status", "models"],
    },
  },
} as const;

export function registerHealthRoute(app: FastifyInstance, deps: HealthDeps): void {
  app.get("/health", { schema: healthSchema }, async () => checkHealth());

  app.get("/ready", { schema: readySchema }, async (_req, reply) => {
    const ready = await checkReady(deps);
    if (ready.status === "ready") return ready;
    return sendError(
      reply,
      503,
      "not_ready",
      { ...ready },
      "One or more dependencies are not ready",
    );
  });

  app.get("/v1/admin/providers/health", { schema: providerHealthSchema }, async (request, reply) => {
    if (!request.ctx.permissions?.includes("usage:read")) {
      return sendError(reply, 403, "forbidden", {}, "API key is not permitted to read provider health (requires usage:read)");
    }
    return checkProviderHealth(deps);
  });
}
