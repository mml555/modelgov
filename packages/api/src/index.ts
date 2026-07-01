import { loadEnv } from "./config/env";
import { loadConfigFromFile, warnUnpricedModels } from "./config/loadConfig";
import { createPool, resolveSsl } from "./db/pool";
import { createLiteLLMClient } from "./services/litellm";
import { createObservability } from "./services/observability";
import { createSafetyGuard } from "./services/safety";
import { startMaintenance } from "./services/maintenance";
import {
  connectRateLimitRedis,
  createRateLimitRedis,
} from "./services/rateLimitRedis";
import type Redis from "ioredis";
import { readFileSync } from "node:fs";
import { resolveSafetyPlan } from "@ai-guard/policy-engine";
import { createDbKeyResolver } from "./modules/keys/resolver";
import { createOidcVerifier } from "./modules/authz/oidc";
import {
  activateConfigVersion,
  getActiveConfigVersion,
  saveConfigVersion,
} from "./modules/policy/repo";
import { buildServer } from "./app";

/**
 * Parse TRUST_PROXY into Fastify's trustProxy shape. Default (unset/"false") is
 * NOT to trust X-Forwarded-For — trusting a client-controlled header lets
 * callers spoof their IP to evade rate limits. Set it to your proxy's IP/CIDR
 * list (comma-separated) or a hop count in production.
 */
function parseTrustProxy(value: string | undefined): boolean | number | string[] {
  if (!value || value === "false") return false;
  if (value === "true") return true;
  const asNumber = Number(value);
  if (Number.isInteger(asNumber) && asNumber >= 0 && value.trim() === String(asNumber)) {
    return asNumber;
  }
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

/** Redact anything resembling a postgres connection string before logging. */
function redactError(err: unknown): string {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return msg.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgres://[redacted]");
}

/** Reject webhook URLs pointing at loopback / link-local / private ranges (SSRF-adjacent). */
function assertPublicHttpUrl(raw: string): void {
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

async function main(): Promise<void> {
  const env = loadEnv();

  let config = loadConfigFromFile(env.AI_GUARD_CONFIG, env.envRefs, {
    strictPricing: env.STRICT_PRICING === "true",
  });

  const pool = createPool(env.DATABASE_URL, {
    max: env.DB_POOL_MAX,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    statementTimeoutMillis: env.DB_STATEMENT_TIMEOUT_MS,
    ssl: resolveSsl(env.DATABASE_SSL, env.DATABASE_SSL_CA),
    onError: (err) =>
      console.error("postgres idle client error:", redactError(err)),
  });

  // Fail fast on an unreachable/misconfigured database rather than booting
  // "healthy" and failing every request.
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    await pool.end().catch(() => {});
    throw new Error(`database unreachable at startup: ${redactError(err)}`);
  }

  // Dynamic policy store (opt-in): use the active DB version if present, else
  // seed it from AI_GUARD_CONFIG so the file becomes version 1. Applied at boot;
  // activating a new version is picked up by a rolling restart.
  if (env.POLICY_STORE_ENABLED === "true") {
    const active = await getActiveConfigVersion(pool);
    if (active) {
      config = active.config;
      console.log(`loaded active policy version ${active.record.id} from the config store`);
    } else {
      const seeded = await saveConfigVersion(pool, {
        yaml: readFileSync(env.AI_GUARD_CONFIG, "utf8"),
        author: "bootstrap",
        note: "seeded from AI_GUARD_CONFIG",
      });
      await activateConfigVersion(pool, seeded.id);
      console.log(`seeded policy store with version ${seeded.id} from AI_GUARD_CONFIG`);
    }
  }

  const litellm = createLiteLLMClient({
    baseUrl: env.LITELLM_BASE_URL,
    apiKey: env.LITELLM_MASTER_KEY,
    timeoutMs: env.LITELLM_TIMEOUT_MS,
  });

  // Safety backends are wired only when configured; otherwise the guard is a
  // no-op (the engine still resolves the plan, but nothing enforces it).
  const presidio =
    env.PRESIDIO_ANALYZER_URL && env.PRESIDIO_ANONYMIZER_URL
      ? {
          analyzerUrl: env.PRESIDIO_ANALYZER_URL,
          anonymizerUrl: env.PRESIDIO_ANONYMIZER_URL,
        }
      : undefined;
  const injection = config.safety.injectionModel
    ? { client: litellm, model: config.safety.injectionModel }
    : undefined;
  const safety = createSafetyGuard({ presidio, injection });

  // OBSERVABILITY_PROVIDER env overrides the config file (lets the full-mode
  // compose flip on Langfuse without editing ai-guard.yaml).
  const observabilityProvider =
    env.OBSERVABILITY_PROVIDER ?? config.observability.provider;
  const observability = createObservability({
    provider: observabilityProvider,
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_HOST,
    captureContent: env.OBSERVABILITY_CAPTURE_CONTENT === "true",
    otelEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelServiceName: env.OTEL_SERVICE_NAME,
  });

  let rateLimitRedis: Redis | undefined;
  if (env.REDIS_URL) {
    rateLimitRedis = createRateLimitRedis({ url: env.REDIS_URL });
    try {
      await connectRateLimitRedis(rateLimitRedis);
    } catch (err) {
      await rateLimitRedis.quit().catch(() => {});
      throw new Error(`Redis unreachable at REDIS_URL: ${String(err)}`);
    }
  }

  if (
    env.BUDGET_ALERT_WEBHOOK_URL &&
    env.BUDGET_ALERT_WEBHOOK_ALLOW_PRIVATE !== "true"
  ) {
    assertPublicHttpUrl(env.BUDGET_ALERT_WEBHOOK_URL);
  }
  const budgetAlert = env.BUDGET_ALERT_WEBHOOK_URL
    ? {
        url: env.BUDGET_ALERT_WEBHOOK_URL,
        secret: env.BUDGET_ALERT_WEBHOOK_SECRET,
      }
    : undefined;

  const keyResolver =
    env.API_KEYS_DB_ENABLED === "true"
      ? createDbKeyResolver(pool, { cacheTtlMs: env.API_KEY_CACHE_TTL_MS })
      : undefined;

  let jwtVerifier: { verify: (token: string) => Promise<import("./plugins/auth").ResolvedPrincipal | null> } | undefined;
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
    console.log(`operator SSO enabled (OIDC issuer ${env.OIDC_ISSUER})`);
  }

  const app = buildServer({
    config,
    pool,
    litellm,
    safety,
    observability,
    apiKeys: env.apiKeys,
    keyResolver,
    jwtVerifier,
    idempotencyCaptureContent: env.IDEMPOTENCY_CAPTURE_CONTENT === "true",
    metrics: env.METRICS_ENABLED === "true",
    metricsAuthToken: env.METRICS_AUTH_TOKEN,
    corsAllowOrigins: parseCsv(env.CORS_ALLOW_ORIGINS),
    bodyLimitBytes: env.REQUEST_BODY_LIMIT_BYTES,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    rateLimit: {
      max: env.RATE_LIMIT_MAX,
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      redis: rateLimitRedis,
      skipOnError: rateLimitRedis
        ? env.RATE_LIMIT_FAIL_OPEN === "true"
        : undefined,
    },
    health: {
      litellmBaseUrl: env.LITELLM_BASE_URL,
      litellmApiKey: env.LITELLM_MASTER_KEY,
      presidioAnalyzerUrl: env.PRESIDIO_ANALYZER_URL,
      presidioAnonymizerUrl: env.PRESIDIO_ANONYMIZER_URL,
    },
    budgetAlert,
  });

  if (rateLimitRedis) {
    app.log.info("rate limiting backed by Redis");
  }

  warnUnpricedModels(config, app.log);

  let maintenanceTimer: NodeJS.Timeout | undefined;
  if (env.MAINTENANCE_ENABLED === "true") {
    const featureRetentionDays: Record<string, number> = {};
    for (const [name, feature] of Object.entries(config.features)) {
      if (feature.retentionDays) featureRetentionDays[name] = feature.retentionDays;
    }
    maintenanceTimer = startMaintenance({
      pool,
      idempotencyStaleMs: env.IDEMPOTENCY_STALE_MS,
      reservationStaleMs: env.RESERVATION_STALE_MS,
      requestLogRetentionMs: env.REQUEST_LOG_RETENTION_MS,
      featureRetentionDays,
      log: app.log,
    });
  }

  // Warn loudly at startup when a safety protection is effectively enabled — via
  // a preset OR an explicit protect block, on the global default OR any feature
  // (a feature can select a stricter preset) — but its backend is missing.
  // Checking only the explicit global protect.pii misses preset-derived modes,
  // which then surface only as a 503 on every affected request at runtime.
  const effectivePlans = Object.values(config.features).map((feature) =>
    resolveSafetyPlan(config, feature),
  );
  if (!presidio && effectivePlans.some((plan) => plan.pii !== "off")) {
    app.log.warn(
      "PII protection is enabled (via preset or protect.pii) but Presidio URLs are not configured — affected requests will fail with 503",
    );
  }
  if (
    !injection &&
    effectivePlans.some((plan) => plan.promptInjection === "block")
  ) {
    app.log.warn(
      "prompt-injection protection is enabled but safety.injection_model is not configured — affected requests will fail with 503",
    );
  }

  let closing = false;
  const close = async (signal: string, exitCode = 0): Promise<void> => {
    if (closing) return; // idempotent: a second signal must not double-close
    closing = true;
    app.log.info({ signal }, "shutting down");
    // Backstop: if graceful close stalls (e.g. an in-flight LLM call), don't hang
    // forever waiting for SIGKILL.
    const forceExit = setTimeout(() => {
      app.log.error("graceful shutdown timed out; forcing exit");
      process.exit(exitCode || 1);
    }, 10_000);
    forceExit.unref();
    try {
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      await app.close();
      if (rateLimitRedis) await rateLimitRedis.quit().catch(() => {});
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

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`ai-guard listening on ${env.HOST}:${env.PORT}`);
}

main().catch((err) => {
  console.error(redactError(err));
  process.exit(1);
});
