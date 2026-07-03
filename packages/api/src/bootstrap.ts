import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type Redis from "ioredis";
import { type ModelgovConfig, resolveSafetyPlan } from "@modelgov/policy-engine";
import type { loadEnv } from "./config/env";
import { loadConfigFromFile } from "./config/loadConfig";
import { assertPoolReachable, createPool, resolveSsl } from "./db/pool";
import { createLiteLLMClient, type LiteLLMClient } from "./services/litellm";
import { createObservability, type Observability } from "./services/observability";
import { createSafetyGuard, type SafetyGuard } from "./services/safety";
import { startMaintenance } from "./services/maintenance";
import {
  connectRateLimitRedis,
  createRateLimitRedis,
} from "./services/rateLimitRedis";
import type { BudgetAlertWebhookConfig } from "./modules/usage/budgetAlerts";
import { createDbKeyResolver } from "./modules/keys/resolver";
import { createOidcVerifier } from "./modules/authz/oidc";
import type { ResolvedPrincipal } from "./plugins/auth";
import {
  activateConfigVersion,
  getActiveConfigVersion,
  saveConfigVersion,
} from "./modules/policy/repo";
import {
  createTenantPolicyResolver,
  type TenantPolicyResolver,
} from "./modules/policy/tenantResolver";

/**
 * Startup assembly. Each function builds ONE dependency (or family of related
 * dependencies) from the environment; `index.ts` is the thin composition root
 * that calls them in order and hands the results to `buildServer`. Keeping the
 * wiring here — out of the entrypoint — makes the boot sequence readable and
 * each step independently reviewable.
 */

export type Env = ReturnType<typeof loadEnv>;
export type PolicyMeta = { configHash?: string; policyVersion?: string };

/** Redact anything resembling a postgres connection string before logging. */
export function redactError(err: unknown): string {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return msg.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgres://[redacted]");
}

/**
 * Parse TRUST_PROXY into Fastify's trustProxy shape. Default (unset/"false") is
 * NOT to trust X-Forwarded-For — trusting a client-controlled header lets
 * callers spoof their IP to evade rate limits. Set it to your proxy's IP/CIDR
 * list (comma-separated) or a hop count in production.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string[] {
  if (!value || value === "false") return false;
  if (value === "true") return true;
  const asNumber = Number(value);
  if (Number.isInteger(asNumber) && asNumber >= 0 && value.trim() === String(asNumber)) {
    return asNumber;
  }
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

/** Reject webhook URLs pointing at loopback / link-local / private ranges (SSRF-adjacent). */
export function assertPublicHttpUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid webhook URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`webhook URL must be http(s): ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (isPrivate) {
    throw new Error(
      `budget alert webhook host '${host}' is private/link-local; set BUDGET_ALERT_WEBHOOK_ALLOW_PRIVATE=true to allow it`,
    );
  }
}

/** Create the Postgres pool and fail fast if it is unreachable at startup. */
export async function createDbPool(env: Env): Promise<Pool> {
  const pool = createPool(env.DATABASE_URL, {
    max: env.DB_POOL_MAX,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    statementTimeoutMillis: env.DB_STATEMENT_TIMEOUT_MS,
    ssl: resolveSsl(env.DATABASE_SSL, env.DATABASE_SSL_CA),
    onError: (err) => console.error("postgres idle client error:", redactError(err)),
  });
  // Fail fast on an unreachable/misconfigured database rather than booting
  // "healthy" and failing every request.
  try {
    await assertPoolReachable(pool);
  } catch (err) {
    await pool.end().catch(() => {});
    throw new Error(`database unreachable at startup: ${redactError(err)}`);
  }
  return pool;
}

/**
 * Resolve the effective policy config and the identity stamped on every request
 * log. With POLICY_STORE_ENABLED, the active DB version wins (seeding version 1
 * from MODELGOV_CONFIG on first boot); otherwise the file config is used and
 * stamped with its own hash.
 */
export async function resolvePolicy(
  env: Env,
  pool: Pool,
): Promise<{ config: ModelgovConfig; policyMeta: PolicyMeta }> {
  const fileConfig = loadConfigFromFile(env.MODELGOV_CONFIG, env.envRefs, {
    strictPricing: env.STRICT_PRICING === "true",
  });

  if (env.POLICY_STORE_ENABLED !== "true") {
    return {
      config: fileConfig,
      policyMeta: {
        configHash: createHash("sha256")
          .update(readFileSync(env.MODELGOV_CONFIG, "utf8"))
          .digest("hex"),
        policyVersion: "file",
      },
    };
  }

  const active = await getActiveConfigVersion(pool);
  if (active) {
    console.log(`loaded active policy version ${active.record.id} from the config store`);
    return {
      config: active.config,
      policyMeta: { configHash: active.record.checksum, policyVersion: active.record.id },
    };
  }
  const seeded = await saveConfigVersion(pool, {
    yaml: readFileSync(env.MODELGOV_CONFIG, "utf8"),
    author: "bootstrap",
    note: "seeded from MODELGOV_CONFIG",
  });
  await activateConfigVersion(pool, seeded.id);
  console.log(`seeded policy store with version ${seeded.id} from MODELGOV_CONFIG`);
  return {
    config: fileConfig,
    policyMeta: { configHash: seeded.checksum, policyVersion: seeded.id },
  };
}

/**
 * Build the per-tenant policy resolver when `MULTI_TENANT_POLICY` is on. Returns
 * undefined (single boot-config path) when off, or when the policy store is
 * disabled — per-tenant resolution needs stored versions to resolve, so we warn
 * and fall back rather than silently resolving everyone to the boot config.
 */
export function createPolicyResolver(
  env: Env,
  pool: Pool,
  fallback: { config: ModelgovConfig; policyMeta: PolicyMeta },
  log?: { warn(obj: unknown, msg: string): void },
): TenantPolicyResolver | undefined {
  if (env.MULTI_TENANT_POLICY !== "true") return undefined;
  if (env.POLICY_STORE_ENABLED !== "true") {
    log?.warn(
      {},
      "MULTI_TENANT_POLICY=true requires POLICY_STORE_ENABLED=true — per-tenant policy resolution is disabled",
    );
    return undefined;
  }
  return createTenantPolicyResolver({ pool, fallback, ttlMs: env.POLICY_CACHE_TTL_MS });
}

export interface RuntimeServices {
  litellm: LiteLLMClient;
  safety: SafetyGuard;
  observability: Observability;
  /** Whether a PII backend (Presidio) is wired — for the missing-backend warning. */
  hasPresidio: boolean;
  /** Whether a prompt-injection model is wired — for the missing-backend warning. */
  hasInjection: boolean;
}

/** Build the LiteLLM client, safety guard, and observability sink from env+config. */
export function createRuntimeServices(env: Env, config: ModelgovConfig): RuntimeServices {
  const litellm = createLiteLLMClient({
    baseUrl: env.LITELLM_BASE_URL,
    apiKey: env.LITELLM_MASTER_KEY,
    timeoutMs: env.LITELLM_TIMEOUT_MS,
    priceOverrides: config.pricing,
  });

  // Safety backends are wired only when configured; otherwise the guard is a
  // no-op (the engine still resolves the plan, but nothing enforces it).
  const presidio =
    env.PRESIDIO_ANALYZER_URL && env.PRESIDIO_ANONYMIZER_URL
      ? { analyzerUrl: env.PRESIDIO_ANALYZER_URL, anonymizerUrl: env.PRESIDIO_ANONYMIZER_URL }
      : undefined;
  const injection = config.safety.injectionModel
    ? { client: litellm, model: config.safety.injectionModel }
    : undefined;
  const safety = createSafetyGuard({ presidio, injection });

  // The dev Langfuse overlay (docker-compose.dev.full.yml) ships well-known
  // default keys for a zero-setup local experience. A production deployment
  // (MODELGOV_PRODUCTION=true, set by the production compose / Helm chart)
  // must never run with them — refuse to boot rather than trace into a
  // Langfuse whose admin credentials and encryption key are public.
  if (
    env.MODELGOV_PRODUCTION === "true" &&
    (env.LANGFUSE_PUBLIC_KEY === "pk-lf-modelgov-local" ||
      env.LANGFUSE_SECRET_KEY === "sk-lf-modelgov-local")
  ) {
    throw new Error(
      "LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY are the dev-overlay defaults (docker-compose.dev.full.yml) — set real Langfuse credentials or unset OBSERVABILITY_PROVIDER for production",
    );
  }

  // OBSERVABILITY_PROVIDER env overrides the config file (lets the full-mode
  // compose flip on Langfuse without editing modelgov.yaml).
  const observability = createObservability({
    provider: env.OBSERVABILITY_PROVIDER ?? config.observability.provider,
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_HOST,
    captureContent: env.OBSERVABILITY_CAPTURE_CONTENT === "true",
    otelEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelServiceName: env.OTEL_SERVICE_NAME,
  });

  return { litellm, safety, observability, hasPresidio: !!presidio, hasInjection: !!injection };
}

/** Connect the rate-limit Redis when REDIS_URL is set; fail fast if unreachable. */
export async function connectRedisIfConfigured(env: Env): Promise<Redis | undefined> {
  if (!env.REDIS_URL) return undefined;
  const redis = createRateLimitRedis({ url: env.REDIS_URL });
  try {
    await connectRateLimitRedis(redis);
  } catch (err) {
    await redis.quit().catch(() => {});
    throw new Error(`Redis unreachable at REDIS_URL: ${String(err)}`);
  }
  return redis;
}

/** Resolve the budget-alert webhook config, validating the URL is not private. */
export function resolveBudgetAlert(env: Env): BudgetAlertWebhookConfig | undefined {
  if (!env.BUDGET_ALERT_WEBHOOK_URL) return undefined;
  if (env.BUDGET_ALERT_WEBHOOK_ALLOW_PRIVATE !== "true") {
    assertPublicHttpUrl(env.BUDGET_ALERT_WEBHOOK_URL);
  }
  return { url: env.BUDGET_ALERT_WEBHOOK_URL, secret: env.BUDGET_ALERT_WEBHOOK_SECRET };
}

export interface AuthProviders {
  keyResolver?: { resolve: (token: string) => Promise<ResolvedPrincipal | null>; clear: () => void };
  jwtVerifier?: { verify: (token: string) => Promise<ResolvedPrincipal | null> };
}

/** Build the DB-backed key resolver and OIDC operator-SSO verifier when enabled. */
export function createAuthProviders(env: Env, pool: Pool): AuthProviders {
  const keyResolver =
    env.API_KEYS_DB_ENABLED === "true"
      ? createDbKeyResolver(pool, { cacheTtlMs: env.API_KEY_CACHE_TTL_MS })
      : undefined;

  let jwtVerifier: AuthProviders["jwtVerifier"];
  if (env.OIDC_ISSUER && env.OIDC_JWKS_URI) {
    let roleMap: Record<string, string | string[]> | undefined;
    if (env.OIDC_ROLE_MAP) {
      try {
        roleMap = JSON.parse(env.OIDC_ROLE_MAP);
      } catch {
        throw new Error("OIDC_ROLE_MAP must be valid JSON");
      }
    }
    jwtVerifier = createOidcVerifier({
      issuer: env.OIDC_ISSUER,
      jwksUri: env.OIDC_JWKS_URI,
      audience: env.OIDC_AUDIENCE,
      rolesClaim: env.OIDC_ROLES_CLAIM,
      nameClaim: env.OIDC_NAME_CLAIM,
      roleMap,
    });
    if (!env.OIDC_AUDIENCE) {
      if (env.MODELGOV_PRODUCTION === "true") {
        throw new Error(
          "OIDC_AUDIENCE is required when operator SSO is enabled in production",
        );
      }
      if (env.OIDC_AUDIENCE_OPTIONAL !== "true") {
        throw new Error(
          "OIDC_AUDIENCE is required when operator SSO is enabled — set OIDC_AUDIENCE or OIDC_AUDIENCE_OPTIONAL=true for local dev only",
        );
      }
      console.warn(
        "OIDC_AUDIENCE is unset (OIDC_AUDIENCE_OPTIONAL=true) — tokens minted for other audiences at the same IdP will pass verification. Set OIDC_AUDIENCE to enforce audience binding.",
      );
    }
    console.log(`operator SSO enabled (OIDC issuer ${env.OIDC_ISSUER})`);
  }

  return { keyResolver, jwtVerifier };
}

/** Start the periodic maintenance sweep when enabled; returns its timer (if any). */
export function startBackgroundJobs(
  env: Env,
  config: ModelgovConfig,
  pool: Pool,
  log: FastifyInstance["log"],
): NodeJS.Timeout | undefined {
  if (env.MAINTENANCE_ENABLED !== "true") return undefined;
  // The stale-lease sweep must outlive the longest a live request can legitimately
  // hold a reservation, or it will release still-in-flight holds. Worst case is a
  // primary attempt plus a fallback attempt, i.e. ~2× the provider timeout. The
  // lease fix makes an early sweep non-corrupting (a late settle still books used
  // and never double-frees), so this is a warning, not a hard failure.
  if (env.RESERVATION_STALE_MS <= env.LITELLM_TIMEOUT_MS * 2) {
    log.warn(
      {
        reservationStaleMs: env.RESERVATION_STALE_MS,
        litellmTimeoutMs: env.LITELLM_TIMEOUT_MS,
      },
      "RESERVATION_STALE_MS is not comfortably greater than 2× LITELLM_TIMEOUT_MS — the stale-lease sweep may release reservations for requests that are still in flight; raise RESERVATION_STALE_MS",
    );
  }
  const featureRetentionDays: Record<string, number> = {};
  for (const [name, feature] of Object.entries(config.features)) {
    if (feature.retentionDays) featureRetentionDays[name] = feature.retentionDays;
  }
  return startMaintenance({
    pool,
    idempotencyStaleMs: env.IDEMPOTENCY_STALE_MS,
    idempotencyCompletedRetentionMs: env.IDEMPOTENCY_COMPLETED_RETENTION_MS,
    reservationStaleMs: env.RESERVATION_STALE_MS,
    requestLogRetentionMs: env.REQUEST_LOG_RETENTION_MS,
    featureRetentionDays,
    log,
  });
}

/**
 * Warn loudly at startup when a safety protection is effectively enabled — via a
 * preset OR an explicit protect block, on the global default OR any feature —
 * but its backend is missing (it would otherwise surface only as a runtime 503).
 */
export function warnMissingSafetyBackends(
  config: ModelgovConfig,
  log: FastifyInstance["log"],
  backends: { hasPresidio: boolean; hasInjection: boolean },
): void {
  const plans = Object.values(config.features).map((feature) => resolveSafetyPlan(config, feature));
  if (!backends.hasPresidio && plans.some((plan) => plan.pii !== "off")) {
    log.warn(
      "PII protection is enabled (via preset or protect.pii) but Presidio URLs are not configured — affected requests will fail with 503",
    );
  }
  if (!backends.hasInjection && plans.some((plan) => plan.promptInjection === "block")) {
    log.warn(
      "prompt-injection protection is enabled but safety.injection_model is not configured — affected requests will fail with 503",
    );
  }
}

export interface LifecycleDeps {
  app: FastifyInstance;
  pool: Pool;
  redis?: Redis;
  maintenanceTimer?: NodeJS.Timeout;
}

/**
 * Install graceful-shutdown signal handlers and last-resort crash handlers.
 * Shutdown is idempotent and bounded: if graceful close stalls (e.g. an in-flight
 * LLM call), a timer forces exit rather than hanging until SIGKILL.
 */
export function installLifecycle(deps: LifecycleDeps): void {
  const { app, pool, redis, maintenanceTimer } = deps;
  let closing = false;
  const close = async (signal: string, exitCode = 0): Promise<void> => {
    if (closing) return; // idempotent: a second signal must not double-close
    closing = true;
    app.log.info({ signal }, "shutting down");
    const forceExit = setTimeout(() => {
      app.log.error("graceful shutdown timed out; forcing exit");
      process.exit(exitCode || 1);
    }, 10_000);
    forceExit.unref();
    try {
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      await app.close();
      if (redis) await redis.quit().catch(() => {});
      await pool.end().catch(() => {});
    } finally {
      clearTimeout(forceExit);
      process.exit(exitCode);
    }
  };
  process.once("SIGTERM", () => void close("SIGTERM"));
  process.once("SIGINT", () => void close("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    app.log.error({ err: reason }, "unhandled promise rejection");
    void close("unhandledRejection", 1);
  });
  process.on("uncaughtException", (err) => {
    app.log.error({ err }, "uncaught exception");
    void close("uncaughtException", 1);
  });
}
