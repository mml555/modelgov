import fastifySwagger from "@fastify/swagger";
import type { FastifyInstance } from "fastify";

/**
 * OpenAPI is GENERATED from the Fastify route schemas, never hand-maintained.
 * `@fastify/swagger` hooks `onRoute` and reads each route's `schema` (tags,
 * params, querystring, body, response) to build the document, so the spec cannot
 * drift from the routes that actually serve traffic. `openapi:export` writes the
 * result to `openapi.json` and CI fails if that committed file is stale.
 *
 * IMPORTANT: this plugin must be registered BEFORE any routes are added, and —
 * because `app.register` is deferred — the routes must themselves be added
 * inside a later `register(...)` so `onRoute` is attached first. `buildServer`
 * does exactly that.
 */
export const OPENAPI_VERSION = "0.0.0";

export function registerOpenApi(app: FastifyInstance): void {
  app.register(fastifySwagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Ai-Guard API",
        version: OPENAPI_VERSION,
        description:
          "Self-hosted AI policy gateway. Every completion is checked against " +
          "budget, token, model-access, and safety policy before a provider is called.",
      },
      tags: [
        { name: "chat", description: "Guarded chat completions." },
        { name: "explain", description: "Dry-run policy evaluation (no provider call)." },
        { name: "usage", description: "Usage and cost reporting." },
        { name: "requests", description: "Request audit records (metadata only)." },
        { name: "admin", description: "Key, audit, governance, and policy administration." },
        { name: "health", description: "Liveness and readiness probes (unauthenticated)." },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "API key or operator token as `Authorization: Bearer <token>`.",
          },
        },
      },
      // Applied to every operation unless a route overrides it (health sets
      // `security: []` to declare itself public).
      security: [{ bearerAuth: [] }],
    },
  });

  // Serve the generated document. Deliberately kept out of the spec itself; it
  // is subject to the global auth hook (not path-exempt), matching prior behavior.
  app.get("/openapi.json", async () => app.swagger());
}
