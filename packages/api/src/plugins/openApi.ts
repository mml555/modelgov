import type { FastifyInstance } from "fastify";
import {
  chatBodyJsonSchema,
  chatSuccessJsonSchema,
  errorJsonSchema,
} from "../modules/chat/schemas";
import {
  explainBodyJsonSchema,
  explainSuccessJsonSchema,
} from "../modules/explain/schemas";
import {
  requestListJsonSchema,
  requestRecordJsonSchema,
} from "../modules/requests/schemas";

export function buildOpenApiDocument() {
  return {
    openapi: "3.0.3",
    info: {
      title: "Ai-Guard API",
      version: "0.1.0",
    },
    paths: {
      "/health": {
        get: {
          tags: ["health"],
          responses: {
            200: { description: "Healthy" },
            503: { description: "Unhealthy", content: json(errorJsonSchema) },
          },
        },
      },
      "/ready": {
        get: {
          tags: ["health"],
          responses: {
            200: { description: "Ready" },
            503: { description: "Not ready", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/usage": {
        get: {
          tags: ["usage"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "userId", in: "query", schema: { type: "string" } },
            { name: "feature", in: "query", schema: { type: "string" } },
            { name: "projectId", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Usage summary" },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/chat": {
        post: {
          tags: ["chat"],
          description:
            "Guarded chat completion. Set `stream: true` for an SSE token stream " +
            "(text/event-stream); requires the feature's output PII protection to be off.",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              schema: { type: "string", maxLength: 255 },
            },
          ],
          requestBody: {
            required: true,
            content: json(chatBodyJsonSchema),
          },
          responses: {
            200: { description: "Chat completion", content: json(chatSuccessJsonSchema) },
            400: { description: "Invalid request", content: json(errorJsonSchema) },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Policy or safety block", content: json(errorJsonSchema) },
            409: { description: "Idempotency key in progress", content: json(errorJsonSchema) },
            422: { description: "Idempotency key reuse", content: json(errorJsonSchema) },
            502: { description: "Provider failure", content: json(errorJsonSchema) },
            503: { description: "Safety unavailable", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/explain": {
        post: {
          tags: ["explain"],
          description:
            "Dry-run policy evaluation without calling LiteLLM or reserving budget.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: json(explainBodyJsonSchema),
          },
          responses: {
            200: { description: "Policy explanation", content: json(explainSuccessJsonSchema) },
            400: { description: "Invalid request", content: json(errorJsonSchema) },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/usage/summary": {
        get: {
          tags: ["usage"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "feature", in: "query", schema: { type: "string" } },
            { name: "userType", in: "query", schema: { type: "string" } },
            { name: "since", in: "query", schema: { type: "string" } },
            { name: "projectId", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Aggregated usage summary" },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/requests": {
        get: {
          tags: ["requests"],
          description: "List request audit records (metadata only).",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "userId", in: "query", schema: { type: "string" } },
            { name: "feature", in: "query", schema: { type: "string" } },
            { name: "userType", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "reasonCode", in: "query", schema: { type: "string" } },
            { name: "since", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer" } },
          ],
          responses: {
            200: { description: "Request list", content: json(requestListJsonSchema) },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/requests/{id}": {
        get: {
          tags: ["requests"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Request record", content: json(requestRecordJsonSchema) },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
            404: { description: "Not found", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/admin/keys": {
        get: {
          tags: ["admin"],
          description: "List API keys (metadata only — never secrets). Requires keys:admin.",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "includeRevoked", in: "query", schema: { type: "boolean" } },
            { name: "projectId", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Key list" },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
          },
        },
        post: {
          tags: ["admin"],
          description:
            "Issue a new API key. The plaintext secret is returned once. Requires keys:admin.",
          security: [{ bearerAuth: [] }],
          responses: {
            201: { description: "Issued key (includes one-time secret)" },
            400: { description: "Invalid request", content: json(errorJsonSchema) },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/admin/keys/{id}": {
        get: {
          tags: ["admin"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Key record" },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
            404: { description: "Not found", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/admin/keys/{id}/rotate": {
        post: {
          tags: ["admin"],
          description: "Mint a new secret for a key; the old secret stops working. Requires keys:admin.",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Rotated key (includes new one-time secret)" },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
            404: { description: "Not found", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/admin/keys/{id}/revoke": {
        post: {
          tags: ["admin"],
          description: "Revoke a key (idempotent). Requires keys:admin.",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Revoked" },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
            404: { description: "Not found", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/admin/audit": {
        get: {
          tags: ["admin"],
          description: "Read the tamper-evident admin audit log. Requires audit:read.",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "action", in: "query", schema: { type: "string" } },
            { name: "actor", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer" } },
          ],
          responses: {
            200: { description: "Audit records (hash-chained)" },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/admin/audit/verify": {
        get: {
          tags: ["admin"],
          description: "Re-walk the audit hash chain and report whether it is intact. Requires audit:read.",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "Chain verification result" },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/admin/erasure": {
        post: {
          tags: ["admin"],
          description:
            "Erase a user's request-linked data (GDPR/CCPA right-to-erasure). Requires data:erase.",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "Erasure counts" },
            400: { description: "Invalid request", content: json(errorJsonSchema) },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/admin/policy/versions": {
        get: {
          tags: ["admin"],
          description: "List stored policy versions (metadata). Requires policy:read.",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "Version list" },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
          },
        },
        post: {
          tags: ["admin"],
          description: "Validate and store a new (inactive) policy version. Requires policy:write.",
          security: [{ bearerAuth: [] }],
          responses: {
            201: { description: "Stored version" },
            400: { description: "Invalid config", content: json(errorJsonSchema) },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/admin/policy/active": {
        get: {
          tags: ["admin"],
          description: "Active policy version metadata. Requires policy:read.",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "Active version" },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
            404: { description: "None active", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/admin/policy/versions/{id}/activate": {
        post: {
          tags: ["admin"],
          description: "Activate a stored version (rollback = activate a prior id). Requires policy:write.",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { description: "Activated" },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
            404: { description: "Not found", content: json(errorJsonSchema) },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
        },
      },
    },
  };
}

export function registerOpenApi(app: FastifyInstance): void {
  app.get("/openapi.json", async () => buildOpenApiDocument());
}

function json(schema: unknown) {
  return {
    "application/json": { schema },
  };
}
