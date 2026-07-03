import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sendError } from "../errors";
import { setRequestContext } from "./requestContext";

const BEARER_PREFIX = "Bearer ";

export interface ApiKeyPrincipal {
  name: string;
  /** Plaintext key (dev / simple mode). Prefer `keyHash` in production. */
  key?: string;
  /** Lowercase SHA-256 hex of the key; lets operators store hashes, not secrets. */
  keyHash?: string;
  /** ISO-8601 instant after which this key is rejected (rotation / expiry). */
  expiresAt?: string;
  projectId?: string;
  environment?: string;
  allowedUserTypes?: readonly string[];
  allowedUserIds?: readonly string[];
  permissions?: readonly string[];
  tenantId?: string;
  budgetNodeId?: string;
}

/**
 * The subset of principal fields set into the request context after a key is
 * verified. Both static (env) keys and DB-resolved keys produce this shape; the
 * secret itself is not carried past verification.
 */
export interface ResolvedPrincipal {
  name: string;
  projectId?: string;
  environment?: string;
  allowedUserTypes?: readonly string[];
  allowedUserIds?: readonly string[];
  permissions?: readonly string[];
  tenantId?: string;
  budgetNodeId?: string;
}

export interface AuthOptions {
  metricsAuthToken?: string;
  /**
   * Optional async resolver consulted when no static key matches — backs the
   * Postgres key store. Already verifies the token (by hash), so it returns a
   * principal to trust directly.
   */
  resolveKey?: (token: string) => Promise<ResolvedPrincipal | null>;
  /**
   * Optional OIDC/JWT verifier for operator SSO. Tried when the bearer token
   * has JWT shape (three dot-separated segments), before the API-key paths.
   */
  verifyJwt?: (token: string) => Promise<ResolvedPrincipal | null>;
}

/** A JWT has exactly three non-empty base64url segments. */
function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export function registerAuth(
  app: FastifyInstance,
  principals: readonly ApiKeyPrincipal[],
  options?: AuthOptions,
): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0];
    if (path === "/health" || path === "/ready") return;
    if (path === "/v1/webhooks/stripe") return;

    if (path === "/metrics") {
      const token = options?.metricsAuthToken;
      if (!token) return;
      const authorization = request.headers.authorization;
      const presented =
        typeof authorization === "string" && authorization.startsWith(BEARER_PREFIX)
          ? authorization.slice(BEARER_PREFIX.length)
          : "";
      if (!constantTimeEquals(presented, token)) {
        return sendError(
          reply,
          401,
          "unauthorized",
          {},
          "Missing or invalid metrics token",
        );
      }
      return;
    }

    const authorization = request.headers.authorization;
    const token =
      typeof authorization === "string" && authorization.startsWith(BEARER_PREFIX)
        ? authorization.slice(BEARER_PREFIX.length)
        : "";

    // Resolution order:
    //  1. Operator SSO — a JWT-shaped token, verified against the IdP.
    //  2. Static (env) API keys — fully in-memory, constant-time.
    //  3. DB-backed API keys — async lookup with a short TTL cache.
    let principal: ResolvedPrincipal | null = null;
    if (token && options?.verifyJwt && looksLikeJwt(token)) {
      principal = await options.verifyJwt(token);
    }
    if (!principal) principal = findPrincipal(token, principals);
    if (!principal && token && options?.resolveKey) {
      principal = await options.resolveKey(token);
    }
    if (!principal) {
      return sendError(
        reply,
        401,
        "unauthorized",
        {},
        "Missing or invalid API key",
      );
    }

    setRequestContext(request, {
      apiKeyName: principal.name,
      projectId: principal.projectId,
      environment: principal.environment,
      allowedUserTypes: principal.allowedUserTypes,
      allowedUserIds: principal.allowedUserIds,
      permissions: principal.permissions ?? ["chat:create"],
      tenantId: principal.tenantId,
      budgetNodeId: principal.budgetNodeId,
    });
  });
}

function findPrincipal(
  candidate: string,
  principals: readonly ApiKeyPrincipal[],
): ApiKeyPrincipal | null {
  const now = Date.now();
  for (const principal of principals) {
    if (matchesPrincipal(candidate, principal, now)) return principal;
  }
  return null;
}

function matchesPrincipal(
  candidate: string,
  principal: ApiKeyPrincipal,
  now: number,
): boolean {
  if (principal.expiresAt) {
    const expiry = Date.parse(principal.expiresAt);
    if (Number.isFinite(expiry) && now > expiry) return false;
  }
  // Prefer hash comparison so operators can store SHA-256 hashes, not raw keys.
  if (principal.keyHash) {
    const candidateHash = createHash("sha256").update(candidate).digest();
    const expected = Buffer.from(principal.keyHash, "hex");
    return (
      candidateHash.length === expected.length &&
      timingSafeEqual(candidateHash, expected)
    );
  }
  if (principal.key) {
    return constantTimeEquals(candidate, principal.key);
  }
  return false;
}

function constantTimeEquals(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}
