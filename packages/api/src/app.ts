import { createHash, randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { AppError, sendError } from "./errors";
import { registerExplainRoute } from "./modules/explain/routes";
import { registerChatRoute, type ChatRouteDeps } from "./modules/chat/routes";
import { registerEmbeddingsRoute } from "./modules/embeddings/routes";
import { registerDocumentsRoute } from "./modules/documents/routes";
import { createDocumentClient, type DocumentAiClient } from "./services/documents";
import { registerHealthRoute } from "./modules/health/routes";
import type { HealthDeps } from "./modules/health/service";
import { registerUsageRoute } from "./modules/usage/routes";
import { registerRequestsRoute } from "./modules/requests/routes";
import { registerAuth, type ApiKeyPrincipal, type ResolvedPrincipal } from "./plugins/auth";
import { registerKeysRoutes } from "./modules/keys/routes";
import { registerAuditRoutes } from "./modules/audit/routes";
import { registerBillingRoutes } from "./modules/billing/routes";
import { registerEmergencyRoutes } from "./modules/emergency/routes";
import { registerGovernanceRoutes } from "./modules/governance/routes";
import { registerPolicyRoutes } from "./modules/policy/routes";
import { registerSetupRoutes } from "./modules/setup/routes";
import { registerWhoamiRoute, registerTenantsRoute } from "./modules/identity/routes";
import { registerMetrics } from "./plugins/metrics";
import { createDomainMetrics, MetricsObservability } from "./plugins/domainMetrics";
import { registerOpenApi } from "./plugins/openApi";
import { Registry } from "prom-client";
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
  logger?: boolean;
  /** pino log level (LOG_LEVEL env). Default "info". */
  logLevel?: string;
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
  /** When true, emit HSTS (intended for TLS-terminated production). */
  production?: boolean;
  bodyLimitBytes?: number;
  /** Max time to receive a full request (slow-client / slowloris backstop). 0 disables. */
  requestTimeoutMs?: number;
  /**
   * External (non-LLM) cost ingestion config for POST /v1/usage/external.
   * `sources` is the accepted-source allowlist; empty disables the endpoint.
   * `maxUsd` is the per-row sanity cap.
   */
  externalCost?: { sources: readonly string[]; maxUsd: number };
  /**
   * Governed document-AI providers for POST /v1/documents/extract. Defaults to an
   * empty client (endpoint registered but every provider returns 400) so the
   * route always appears in the OpenAPI spec.
   */
  documentClient?: DocumentAiClient;
  /** Worst-case pages reserved per document extract (budget-cap floor). */
  documentMaxPages?: number;
  /**
   * How much to trust `X-Forwarded-For`. Default `false` — do NOT derive the
   * client IP from a client-controlled header (that lets callers spoof it to
   * evade rate limits). Set to your proxy IPs/CIDRs (or a hop count) in prod.
   */
  trustProxy?: boolean | number | string | string[];
  rateLimit?: RateLimitOptions;
  health?: Omit<HealthDeps, "pool">;
  /**
   * Two-person rule for the policy store: when true, a saved version is
   * `proposed` and must be approved by a different operator (holding
   * `policy:approve`) before it can be activated. Default: off.
   */
  policyApprovalRequired?: boolean;
  /**
   * Fingerprint of the boot config's non-hot-reloadable fields. When set and hot
   * reload is on, activating a version that changes them is refused (would
   * otherwise half-apply). See frozenPolicyFieldsFingerprint.
   */
  policyFrozenFieldsFingerprint?: string;
  /** Dev-only setup wizard: write provider secrets to the host .env. */
  setupApi?: { projectRoot: string };
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
const MAX_REQUEST_ID_LENGTH = 128;

/** Client-facing request id: a bounded inbound x-request-id, else a fresh UUID. */
function requestIdFromHeaders(headers: IncomingHttpHeaders): string {
  const h = headers["x-request-id"];
  return typeof h === "string" && h.trim() && h.length <= MAX_REQUEST_ID_LENGTH
    ? h.trim()
    : randomUUID();
}

export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: opts.logLevel ?? "info",
            // Defense-in-depth: even though the default request serializer omits
            // headers, redact bearer/API-key/cookie material so a future
            // `log.info({ req })` or custom serializer can never emit a secret.
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                'req.headers["x-api-key"]',
                "headers.authorization",
                "headers.cookie",
                'headers["x-api-key"]',
                "authorization",
              ],
              censor: "[redacted]",
            },
          },
    // Unify Fastify's log `reqId` with the client-facing request id: honor an
    // inbound x-request-id (bounded) or mint a UUID. requestContext reuses this
    // same request.id, so pino logs, the error-envelope requestId, and the
    // x-modelgov-request-id header all correlate to one id per request.
    genReqId: (req) => requestIdFromHeaders(req.headers),
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
    if (opts.production) {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }

    const origin = request.headers.origin;
    if (typeof origin === "string" && corsOrigins.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
      reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
      reply.header(
        "access-control-allow-headers",
        "authorization, content-type, idempotency-key, x-modelgov-tenant",
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

  // When metrics are on, share one registry between RED/process metrics and the
  // domain counters, and wrap observability so every chat outcome updates the
  // domain metrics (spend, budget-blocks, fallbacks) the runbooks alert on.
  const metricsRegistry = opts.metrics ? new Registry() : undefined;
  const observability =
    metricsRegistry
      ? new MetricsObservability(opts.observability, createDomainMetrics(metricsRegistry))
      : opts.observability;

  // Routes are registered inside a deferred `register(...)` so they are added
  // AFTER @fastify/swagger's `onRoute` hook is attached (registerOpenApi above
  // registers swagger, which is also deferred). Adding routes synchronously here
  // would run before that hook and they'd be missing from the generated spec.
  // The child scope inherits the root's auth/rate-limit hooks and error handler.
  app.register(async (scope) => {
    registerHealthRoute(scope, {
      pool: opts.pool,
      litellmBaseUrl: opts.health?.litellmBaseUrl,
      litellmApiKey: opts.health?.litellmApiKey,
      presidioAnalyzerUrl: opts.health?.presidioAnalyzerUrl,
      presidioAnonymizerUrl: opts.health?.presidioAnonymizerUrl,
      fetchImpl: opts.health?.fetchImpl,
    });
    registerWhoamiRoute(scope);
    registerTenantsRoute(scope, opts.pool);
    registerUsageRoute(scope, opts.pool, {
      defaultProjectId: opts.config.project.name,
      globalMonthlyCapUsd: opts.config.budgets.global?.monthlyUsd,
      // Per-tenant / hot-reloaded cap: resolve the effective tenant's active
      // policy cap instead of the static boot cap when a resolver is present.
      tenantPolicy: opts.tenantPolicy,
      externalCost: opts.externalCost,
    });
    registerRequestsRoute(scope, opts.pool, { defaultProjectId: opts.config.project.name });
    registerBillingRoutes(scope, opts.pool, opts.billing);
    registerEmergencyRoutes(scope, opts.pool);
    if (opts.keyResolver) {
      // Clearing the resolver cache on any mutation makes revoke/rotate effective
      // immediately rather than after the cache TTL.
      registerKeysRoutes(scope, opts.pool, {
        onKeysChanged: opts.keyResolver.clear,
      });
      registerAuditRoutes(scope, opts.pool);
      registerGovernanceRoutes(scope, opts.pool);
      registerPolicyRoutes(scope, opts.pool, {
        // Activating a version evicts this replica's cached policy immediately;
        // other replicas are invalidated via LISTEN/NOTIFY (TTL is the backstop).
        // Only defined when a resolver exists (hot reload on) so the response note
        // is accurate on the boot-config path.
        onActivated: opts.tenantPolicy
          ? (tenantId) => opts.tenantPolicy?.invalidate(tenantId)
          : undefined,
        approvalRequired: opts.policyApprovalRequired,
        frozenFieldsFingerprint: opts.policyFrozenFieldsFingerprint,
        setupBypassFrozenGuard: !!opts.setupApi && opts.production !== true,
      });
    }
    registerSetupRoutes(scope, {
      enabled: !!opts.setupApi,
      projectRoot: opts.setupApi?.projectRoot ?? ".",
      production: opts.production === true,
    });
    registerExplainRoute(scope, {
      config: opts.config,
      pool: opts.pool,
      tenantPolicy: opts.tenantPolicy,
    });
    registerChatRoute(scope, {
      config: opts.config,
      pool: opts.pool,
      litellm: opts.litellm,
      safety: opts.safety,
      observability,
      budgetAlert: opts.budgetAlert,
      idempotencyCaptureContent: opts.idempotencyCaptureContent,
      hierarchicalBudgets: opts.hierarchicalBudgets,
      streamMaxDurationMs: opts.streamMaxDurationMs,
      policyMeta: opts.policyMeta,
      tenantPolicy: opts.tenantPolicy,
      billing: opts.billing,
    });
    registerEmbeddingsRoute(scope, {
      config: opts.config,
      pool: opts.pool,
      litellm: opts.litellm,
      safety: opts.safety,
      observability,
      hierarchicalBudgets: opts.hierarchicalBudgets,
      policyMeta: opts.policyMeta,
      tenantPolicy: opts.tenantPolicy,
      idempotencyCaptureContent: opts.idempotencyCaptureContent,
      // Embeddings incur real provider spend — they ride the same credit
      // wallet / usage meter as chat, or billing modes would have a bypass.
      billing: opts.billing,
    });
    registerDocumentsRoute(scope, {
      config: opts.config,
      pool: opts.pool,
      // Default to an empty client so the route (and OpenAPI spec) always exist;
      // every provider then returns 400 until one is configured.
      documentClient: opts.documentClient ?? createDocumentClient({}),
      safety: opts.safety,
      observability,
      hierarchicalBudgets: opts.hierarchicalBudgets,
      policyMeta: opts.policyMeta,
      tenantPolicy: opts.tenantPolicy,
      billing: opts.billing,
      idempotencyCaptureContent: opts.idempotencyCaptureContent,
      maxPages: opts.documentMaxPages ?? 30,
    });
  });

  // Kept on the root instance (not in the spec): /metrics is an ops endpoint,
  // not part of the public API surface.
  if (opts.metrics) {
    registerMetrics(app, { pool: opts.pool, register: metricsRegistry });
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

    const errStatus = httpErrorStatus(err);
    if (errStatus === 429) {
      return sendError(
        reply,
        429,
        "rate_limit_exceeded",
        {},
        err instanceof Error ? err.message : "Rate limit exceeded",
      );
    }

    // Body over the configured limit (Fastify FST_ERR_CTP_BODY_TOO_LARGE) — a
    // real client error, common for vision requests carrying base64 images.
    // Surface a clean 413 with a hint instead of an opaque 500 + error log.
    if (errStatus === 413) {
      return sendError(
        reply,
        413,
        "payload_too_large",
        {},
        "Request body exceeds the configured limit (raise REQUEST_BODY_LIMIT_BYTES for large/vision payloads)",
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

/** Read a numeric `statusCode` off a plain thrown Error (e.g. @fastify/rate-limit
 * 429, or Fastify's 413 body-too-large) — these are not AppErrors. */
function httpErrorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null || !("statusCode" in err)) return undefined;
  const status = (err as { statusCode: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
}
