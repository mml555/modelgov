import { createHash } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { AppError, sendError } from "./errors";
import { registerExplainRoute } from "./modules/explain/routes";
import { registerChatRoute, type ChatRouteDeps } from "./modules/chat/routes";
import { registerHealthRoute } from "./modules/health/routes";
import type { HealthDeps } from "./modules/health/service";
import { registerUsageRoute } from "./modules/usage/routes";
import { registerRequestsRoute } from "./modules/requests/routes";
import { registerAuth, type ApiKeyPrincipal, type ResolvedPrincipal } from "./plugins/auth";
import { registerKeysRoutes } from "./modules/keys/routes";
import { registerAuditRoutes } from "./modules/audit/routes";
import { registerGovernanceRoutes } from "./modules/governance/routes";
import { registerPolicyRoutes } from "./modules/policy/routes";
import { appendAudit } from "./modules/audit/repo";
import { registerMetrics } from "./plugins/metrics";
import { registerOpenApi } from "./plugins/openApi";
import { registerRequestContext } from "./plugins/requestContext";
import type Redis from "ioredis";

export interface RateLimitOptions {
  max: number;
  windowMs: number;
  redis?: Redis;
  /** When false and Redis is configured, rate-limit errors reject requests. Default: fail-closed with Redis. */
  skipOnError?: boolean;
}

export interface BuildServerOptions extends ChatRouteDeps {
  /** Fastify logging. Defaults to true; tests pass false. */
  logger?: boolean;
  /** Bearer token required for non-health endpoints. Omit only in tests. */
  apiKey?: string;
  apiKeys?: readonly ApiKeyPrincipal[];
  /**
   * Postgres-backed key store consulted when no static key matches. Providing it
   * also registers the `/v1/admin/keys` management routes (guarded by the
   * `keys:admin` permission).
   */
  keyResolver?: {
    resolve: (token: string) => Promise<ResolvedPrincipal | null>;
    clear: () => void;
  };
  /**
   * Optional OIDC verifier for operator SSO. When set, JWT-shaped bearer tokens
   * are verified against the IdP and mapped to operator roles/permissions.
   */
  jwtVerifier?: { verify: (token: string) => Promise<ResolvedPrincipal | null> };
  /**
   * Allow booting with NO authentication. Without this flag, and with neither
   * apiKey nor apiKeys configured, buildServer throws rather than silently
   * starting a fully open server. Intended for tests only.
   */
  allowUnauthenticated?: boolean;
  /** Expose the Prometheus /metrics endpoint (default off; enabled in production). */
  metrics?: boolean;
  /** When set, /metrics requires Authorization: Bearer <token>. */
  metricsAuthToken?: string;
  /** Explicit CORS origin allowlist. Empty/unset = no CORS headers (default deny). */
  corsAllowOrigins?: readonly string[];
  bodyLimitBytes?: number;
  /** Max time to receive a full request (slow-client / slowloris backstop). 0 disables. */
  requestTimeoutMs?: number;
  /**
   * How much to trust `X-Forwarded-For`. Default `false` — do NOT derive the
   * client IP from a client-controlled header (that lets callers spoof it to
   * evade rate limits). Set to your proxy IPs/CIDRs (or a hop count) in prod.
   */
  trustProxy?: boolean | number | string | string[];
  rateLimit?: RateLimitOptions;
  health?: Omit<HealthDeps, "pool">;
}

/**
 * Rate-limit bucket key. Prefer the presented API key (hashed, so the raw secret
 * never lands in Redis), so limits are per-key and can't be evaded by rotating
 * `X-Forwarded-For`. Fall back to the (now trustworthy) source IP for
 * unauthenticated traffic.
 */
function rateLimitKey(request: FastifyRequest): string {
  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length);
    if (token) return `k:${createHash("sha256").update(token).digest("hex")}`;
  }
  return `ip:${request.ip}`;
}

/**
 * Build the Fastify app from injected dependencies (config, pool, LiteLLM
 * client, safety guard). Dependency injection keeps the orchestration testable
 * with fakes and `app.inject()`; no network or real models required.
 */
export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? true,
    bodyLimit: opts.bodyLimitBytes,
    trustProxy: opts.trustProxy ?? false,
    requestTimeout: opts.requestTimeoutMs ?? 0,
  });

  registerRequestContext(app);

  // Security headers on every response + an explicit (default-deny) CORS policy.
  // Registered before auth so CORS preflight (OPTIONS, which carries no bearer)
  // short-circuits instead of 401-ing.
  const corsOrigins = new Set(opts.corsAllowOrigins ?? []);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");

    const origin = request.headers.origin;
    if (typeof origin === "string" && corsOrigins.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
      reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
      reply.header(
        "access-control-allow-headers",
        "authorization, content-type, idempotency-key",
      );
      reply.header("access-control-max-age", "600");
    }
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  registerOpenApi(app);
  if (opts.rateLimit) {
    app.register(rateLimit, {
      max: opts.rateLimit.max,
      timeWindow: opts.rateLimit.windowMs,
      redis: opts.rateLimit.redis,
      skipOnError: opts.rateLimit.skipOnError ?? !opts.rateLimit.redis,
      hook: "onRequest",
      keyGenerator: rateLimitKey,
      allowList: (request) => {
        const path = request.url.split("?", 1)[0];
        return path === "/health" || path === "/ready" || path === "/metrics";
      },
    });
  }

  const apiKeys = opts.apiKeys ?? (
    opts.apiKey
      ? [{ name: "default", key: opts.apiKey, permissions: ["chat:create"] }]
      : []
  );
  if (apiKeys.length > 0 || opts.keyResolver || opts.jwtVerifier) {
    registerAuth(app, apiKeys, {
      metricsAuthToken: opts.metricsAuthToken,
      resolveKey: opts.keyResolver?.resolve,
      verifyJwt: opts.jwtVerifier?.verify,
    });
  } else if (!opts.allowUnauthenticated) {
    throw new Error(
      "No API keys configured — refusing to start an unauthenticated server. " +
        "Set apiKey/apiKeys, provide a keyResolver, or pass allowUnauthenticated: true (tests only).",
    );
  }

  registerHealthRoute(app, {
    pool: opts.pool,
    litellmBaseUrl: opts.health?.litellmBaseUrl,
    litellmApiKey: opts.health?.litellmApiKey,
    presidioAnalyzerUrl: opts.health?.presidioAnalyzerUrl,
    presidioAnonymizerUrl: opts.health?.presidioAnonymizerUrl,
    fetchImpl: opts.health?.fetchImpl,
  });
  registerUsageRoute(app, opts.pool, { defaultProjectId: opts.config.project.name });
  registerRequestsRoute(app, opts.pool, { defaultProjectId: opts.config.project.name });
  if (opts.keyResolver) {
    // Clearing the resolver cache on any mutation makes revoke/rotate effective
    // immediately rather than after the cache TTL.
    // Best-effort audit append: a chain-write failure logs but never fails the
    // mutation itself.
    const recordAudit = async (event: {
      actor: string;
      action: string;
      target?: string;
      metadata?: Record<string, unknown>;
    }): Promise<void> => {
      try {
        await appendAudit(opts.pool, event);
      } catch (err) {
        app.log.error({ err, action: event.action }, "audit append failed");
      }
    };
    registerKeysRoutes(app, opts.pool, {
      onKeysChanged: opts.keyResolver.clear,
      recordAudit,
    });
    registerAuditRoutes(app, opts.pool);
    registerGovernanceRoutes(app, opts.pool, { recordAudit });
    registerPolicyRoutes(app, opts.pool, { recordAudit });
  }
  registerExplainRoute(app, { config: opts.config, pool: opts.pool });
  registerChatRoute(app, {
    config: opts.config,
    pool: opts.pool,
    litellm: opts.litellm,
    safety: opts.safety,
    observability: opts.observability,
    budgetAlert: opts.budgetAlert,
    idempotencyCaptureContent: opts.idempotencyCaptureContent,
  });

  if (opts.metrics) {
    registerMetrics(app, { pool: opts.pool });
  }

  app.addHook("onClose", async () => {
    await opts.observability.shutdown();
  });

  app.setErrorHandler((err, req, reply) => {
    // Schema validation rejects the body before the handler runs (Fastify
    // `schema.body`). Map those to our 400 envelope and surface which fields
    // were wrong — a bare "Invalid request" is useless to the caller. These are
    // client errors, so don't error-log them.
    const detail = validationErrorDetail(err);
    if (detail !== null) {
      return sendError(
        reply,
        400,
        "invalid_request",
        detail ? { detail } : {},
        "Invalid request",
      );
    }
    req.log.error({ err }, "unhandled error");
    if (err instanceof AppError) {
      return sendError(reply, err.status, err.code, err.details, err.message);
    }
    return sendError(reply, 500, "internal_error", {}, "Internal server error");
  });

  return app;
}

interface ValidationIssue {
  instancePath?: string;
  message?: string;
  params?: { missingProperty?: string };
}

/**
 * Returns a human-readable detail string for a Fastify schema-validation error,
 * or null if `err` is not a validation error (so the caller falls through to
 * AppError / 500 handling). Empty string means "validation error, no detail".
 */
function validationErrorDetail(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("validation" in err)) {
    return null;
  }
  const issues = (err as { validation?: ValidationIssue[] }).validation;
  if (!Array.isArray(issues) || issues.length === 0) return "";
  return issues
    .map((issue) => {
      const field = issue.params?.missingProperty
        ? issue.params.missingProperty
        : (issue.instancePath ?? "").replace(/^\//, "").replace(/\//g, ".");
      const message = issue.message ?? "invalid";
      return field ? `${field}: ${message}` : message;
    })
    .join("; ");
}
