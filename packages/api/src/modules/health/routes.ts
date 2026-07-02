import type { FastifyInstance } from "fastify";
import { sendError } from "../../errors";
import { checkHealth, checkReady, type HealthDeps } from "./service";

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
}
