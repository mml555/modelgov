import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type Redis from "ioredis";
import { type ModelgovConfig, PolicyConfigError, resolveSafetyPlan } from "@modelgov/policy-engine";
import type { loadEnv } from "./config/env";
import { loadConfigFromFile, resolveEnvRefs } from "./config/loadConfig";
import { assertPoolReachable, createPool, resolveSsl } from "./db/pool";
import { createLiteLLMClient, type LiteLLMClient } from "./services/litellm";
import { createObservability, type Observability } from "./services/observability";
import { createSafetyGuard, type SafetyGuard } from "./services/safety";
import { startMaintenance } from "./services/maintenance";
import type { BillingService } from "./modules/billing/service";
import {
  connectRateLimitRedis,
  createRateLimitRedis,
} from "./services/rateLimitRedis";
import type { BudgetAlertWebhookConfig } from "./modules/usage/budgetAlerts";
import { createDbKeyResolver } from "./modules/keys/resolver";
import { assertPublicHttpUrl } from "./util/httpUrlGuard";
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
import {
  startPolicyActivationListener,
  type PolicyActivationListener,
} from "./modules/policy/listener";

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

// Webhook-URL SSRF guard (loopback / link-local / private ranges) is the shared
// `assertPublicHttpUrl` in util/httpUrlGuard — single-sourced with the runtime
// delivery sinks so a rule added in one place can't drift from the other.
// Re-exported here for existing importers (bootstrap tests, resolveBudgetAlert).
export { assertPublicHttpUrl };

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
    onMissingEnvRef: (varName, provider) =>
      console.warn(
        `provider "${provider}" api_key references env/${varName}, which is unset — the provider key resolves to empty`,
      ),
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

  let active: Awaited<ReturnType<typeof getActiveConfigVersion>> = null;
  try {
    active = await getActiveConfigVersion(pool);
  } catch (err) {
    // ONLY a parse/validation failure of the stored version falls back to the
    // file config: e.g. a version written by a newer-schema replica during a
    // rolling upgrade reaches this older one and won't parse. Booting on the
    // known-good file baseline beats crash-looping there. A store READ failure
    // (DB down, connection/statement timeout) must NOT silently bypass the
    // DB-active policy — it would strand the gateway on the file config until a
    // restart even after the DB recovers — so those errors propagate and fail
    // boot (the orchestrator retries).
    if (!(err instanceof PolicyConfigError)) throw err;
    console.error(
      "active policy version failed to PARSE; booting on the file config (MODELGOV_CONFIG) instead. Roll back or fix the active version.",
      err,
    );
    return {
      config: fileConfig,
      policyMeta: {
        configHash: createHash("sha256").update(readFileSync(env.MODELGOV_CONFIG, "utf8")).digest("hex"),
        policyVersion: "file-fallback",
      },
    };
  }
  if (active) {
    console.log(`loaded active policy version ${active.record.id} from the config store`);
    return {
      // Resolve env/VAR provider-key references, same as the file path — a stored
      // version can reference secrets without baking them into the DB.
      config: resolveEnvRefs(active.config, env.envRefs),
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
 * Build the request-time policy resolver. Per-request resolution powers two
 * features that share one mechanism (a TTL-cached read of the active
 * `config_versions` row): multi-tenant policy (each tenant on its own version)
 * and single-tenant zero-restart hot reload (activation applies without a
 * restart). Both need the versioned store to resolve against.
 *
 * Returns undefined (the boot-config path, activation applies on restart) when
 * the store is off, or when neither feature is requested. `MULTI_TENANT_POLICY`
 * without the store is a misconfiguration, so we warn.
 */
export function createPolicyResolver(
  env: Env,
  pool: Pool,
  fallback: { config: ModelgovConfig; policyMeta: PolicyMeta },
  log?: { warn(obj: unknown, msg: string): void; error?(obj: unknown, msg: string): void },
): TenantPolicyResolver | undefined {
  const multiTenant = env.MULTI_TENANT_POLICY === "true";
  const hotReload = env.POLICY_HOT_RELOAD === "true";
  if (env.POLICY_STORE_ENABLED !== "true") {
    if (multiTenant) {
      log?.warn(
        {},
        "MULTI_TENANT_POLICY=true requires POLICY_STORE_ENABLED=true — per-tenant policy resolution is disabled",
      );
    }
    return undefined;
  }
  // Store is on: resolve per request only if a feature that needs it is enabled.
  // Single-tenant with hot reload off keeps the boot-config path.
  if (!multiTenant && !hotReload) return undefined;
  // Single-tenant hot reload resolves the DEFAULT tenant only (perTenant=false).
  // A version saved by a tenant-bound operator key lands under that key's
  // tenant_id, so it would never be resolved here and hot reload would silently
  // no-op. Warn so the misconfiguration is visible — save/activate under the
  // default tenant, or turn on MULTI_TENANT_POLICY for per-tenant resolution.
  if (!multiTenant && hotReload) {
    log?.warn(
      {},
      "POLICY_HOT_RELOAD (single-tenant) resolves the default tenant only — policy versions saved by a tenant-bound operator key will not hot-reload; save/activate under the default tenant or enable MULTI_TENANT_POLICY",
    );
  }
  return createTenantPolicyResolver({
    pool,
    fallback,
    ttlMs: env.POLICY_CACHE_TTL_MS,
    perTenant: multiTenant,
    // Resolve env/VAR provider keys on store-loaded versions, like the file path.
    resolveConfig: (config) => resolveEnvRefs(config, env.envRefs),
    log: log?.error ? { error: (obj, msg) => log.error?.(obj, msg) } : undefined,
  });
}

/**
 * Start the policy-activation LISTEN connection so an activation on any replica
 * invalidates this replica's cached policy immediately (the TTL is the backstop).
 * Returns undefined when there is no resolver to invalidate — the boot-config
 * path has nothing to hot-reload.
 */
export function startPolicyListener(
  env: Env,
  tenantPolicy: TenantPolicyResolver | undefined,
  log: { info(msg: string): void; warn(obj: unknown, msg: string): void },
): PolicyActivationListener | undefined {
  if (!tenantPolicy) return undefined;
  return startPolicyActivationListener({
    clientConfig: {
      connectionString: env.DATABASE_URL,
      ssl: resolveSsl(env.DATABASE_SSL, env.DATABASE_SSL_CA),
    },
    onActivated: (tenantId) => tenantPolicy.invalidate(tenantId),
    log: { info: (m) => log.info(m), warn: (o, m) => log.warn(o, m) },
  });
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
    retry: config.routing.retry,
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
  const allowPrivateHosts = env.BUDGET_ALERT_WEBHOOK_ALLOW_PRIVATE === "true";
  if (!allowPrivateHosts) {
    assertPublicHttpUrl(env.BUDGET_ALERT_WEBHOOK_URL);
  }
  return {
    url: env.BUDGET_ALERT_WEBHOOK_URL,
    secret: env.BUDGET_ALERT_WEBHOOK_SECRET,
    allowPrivateHosts,
  };
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
      tenantClaim: env.OIDC_TENANT_CLAIM,
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
  billing?: BillingService,
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
    billing,
    allowPrivateWebhookHosts: env.BUDGET_ALERT_WEBHOOK_ALLOW_PRIVATE === "true",
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

/**
 * Warn when a feature enables BOTH PII masking and grounding. Grounding ships the
 * retrieved context to the provider VERBATIM (un-masked) so citation
 * verification can match quotes, so PII inside grounded context is NOT masked
 * even though the feature requests PII protection. This is by design (ground only
 * on trusted sources) — surface it at boot so the weaker guarantee for grounded
 * features is explicit rather than a silent surprise.
 */
export function warnGroundingPiiExposure(
  config: ModelgovConfig,
  log: FastifyInstance["log"],
): void {
  const affected = Object.entries(config.features)
    .filter(([, feature]) => {
      const plan = resolveSafetyPlan(config, feature);
      return plan.grounding === "strict" && plan.pii !== "off";
    })
    .map(([name]) => name);
  if (affected.length > 0) {
    log.warn(
      { features: affected },
      "features enable both PII masking and grounding — grounded context is sent to the provider un-masked (verbatim citation requires it), so PII in retrieved context is NOT masked; ground only on trusted sources",
    );
  }
}

export interface LifecycleDeps {
  app: FastifyInstance;
  pool: Pool;
  redis?: Redis;
  maintenanceTimer?: NodeJS.Timeout;
  /** Dedicated LISTEN connection for policy hot reload; closed before the pool. */
  policyListener?: { stop(): Promise<void> };
}

/**
 * Install graceful-shutdown signal handlers and last-resort crash handlers.
 * Shutdown is idempotent and bounded: if graceful close stalls (e.g. an in-flight
 * LLM call), a timer forces exit rather than hanging until SIGKILL.
 */
export function installLifecycle(deps: LifecycleDeps): void {
  const { app, pool, redis, maintenanceTimer, policyListener } = deps;
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
      if (policyListener) await policyListener.stop().catch(() => {});
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
