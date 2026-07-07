import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

const MAX_REQUEST_ID_LENGTH = 128;

export interface RequestContext {
  readonly requestId: string;
  /**
   * Display name of the authenticated principal — the API key's `name` or the
   * OIDC subject. Used as the audit `actor`. NOT a credential (the secret is
   * never carried past verification); named `principalName`, not `apiKeyName`,
   * so it reads accurately for OIDC operators too.
   */
  readonly principalName?: string;
  readonly projectId?: string;
  readonly environment?: string;
  readonly allowedUserTypes?: readonly string[];
  readonly allowedUserIds?: readonly string[];
  readonly permissions?: readonly string[];
  readonly userId?: string;
  readonly orgId?: string;
  readonly tenantId?: string;
  /**
   * Whether the API key/operator is bound to a specific tenant. Bound principals
   * are locked to their tenant; unbound (platform) principals may target a tenant
   * via the `X-Modelgov-Tenant` header (which sets `tenantId`). Lets endpoints and
   * the console tell "locked to my tenant" from "platform, may switch".
   */
  readonly tenantBound?: boolean;
  /** Leaf budget node bound to the API key (hierarchical budgets). */
  readonly budgetNodeId?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

export function registerRequestContext(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    // Reuse Fastify's request.id (set by genReqId from x-request-id, or a fresh
    // UUID) so the client-facing ctx.requestId, the value pino logs as `reqId`,
    // and the x-modelgov-request-id header are all the SAME id. Fall back to the
    // header/UUID logic directly if genReqId is not configured (defensive).
    const requestIdHeader = request.headers["x-request-id"];
    const requestId =
      typeof request.id === "string" && request.id
        ? request.id
        : typeof requestIdHeader === "string" &&
            requestIdHeader.trim() &&
            requestIdHeader.length <= MAX_REQUEST_ID_LENGTH
          ? requestIdHeader.trim()
          : randomUUID();

    Object.defineProperty(request, "ctx", {
      value: Object.freeze({ requestId }),
      enumerable: true,
      configurable: true,
      writable: false,
    });
  });
}

export function setRequestContext(
  request: { ctx: RequestContext },
  patch: Omit<Partial<RequestContext>, "requestId">,
): void {
  Object.defineProperty(request, "ctx", {
    value: Object.freeze({ ...request.ctx, ...patch }),
    enumerable: true,
    configurable: true,
    writable: false,
  });
}
