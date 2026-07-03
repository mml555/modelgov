import { loadEnv } from "./config/env";
import { assertProductionEnv } from "./config/productionGuards";
import { warnUnpricedModels } from "./config/loadConfig";
import { setConfigVersionsRls } from "./modules/policy/repo";
import { buildServer } from "./app";
import {
  connectRedisIfConfigured,
  createAuthProviders,
  createDbPool,
  createPolicyResolver,
  createRuntimeServices,
  installLifecycle,
  parseCsv,
  parseTrustProxy,
  redactError,
  resolveBudgetAlert,
  resolvePolicy,
  startBackgroundJobs,
  warnMissingSafetyBackends,
} from "./bootstrap";

/**
 * Composition root: assemble each dependency via the focused `bootstrap`
 * helpers, hand them to `buildServer`, then start background jobs and the
 * lifecycle handlers. No wiring logic lives here — only the order of assembly.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  assertProductionEnv(env);

  const pool = await createDbPool(env);
  // Opt-in RLS: make config_versions reads/writes set the tenant context so the
  // app can run as a non-owner role under the RLS policy (no-op when off).
  setConfigVersionsRls(env.DB_RLS_ENABLED === "true");
  const { config, policyMeta } = await resolvePolicy(env, pool);
  const tenantPolicy = createPolicyResolver(env, pool, { config, policyMeta }, {
    warn: (obj, msg) => console.warn(msg, obj),
  });
  const { litellm, safety, observability, hasPresidio, hasInjection } =
    createRuntimeServices(env, config);
  const redis = await connectRedisIfConfigured(env);
  const budgetAlert = resolveBudgetAlert(env);
  const { keyResolver, jwtVerifier } = createAuthProviders(env, pool);

  const app = buildServer({
    config,
    pool,
    litellm,
    safety,
    observability,
    apiKeys: env.apiKeys,
    keyResolver,
    jwtVerifier,
    hierarchicalBudgets: env.HIERARCHICAL_BUDGETS === "true",
    policyMeta,
    tenantPolicy,
    idempotencyCaptureContent: env.IDEMPOTENCY_CAPTURE_CONTENT === "true",
    metrics: env.METRICS_ENABLED === "true",
    metricsAuthToken: env.METRICS_AUTH_TOKEN,
    logLevel: env.LOG_LEVEL,
    production: env.MODELGOV_PRODUCTION === "true",
    corsAllowOrigins: parseCsv(env.CORS_ALLOW_ORIGINS),
    bodyLimitBytes: env.REQUEST_BODY_LIMIT_BYTES,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    rateLimit: {
      max: env.RATE_LIMIT_MAX,
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      redis,
      skipOnError: redis ? env.RATE_LIMIT_FAIL_OPEN === "true" : undefined,
    },
    health: {
      litellmBaseUrl: env.LITELLM_BASE_URL,
      litellmApiKey: env.LITELLM_MASTER_KEY,
      presidioAnalyzerUrl: env.PRESIDIO_ANALYZER_URL,
      presidioAnonymizerUrl: env.PRESIDIO_ANONYMIZER_URL,
    },
    budgetAlert,
  });

  if (redis) app.log.info("rate limiting backed by Redis");
  warnUnpricedModels(config, app.log);
  warnMissingSafetyBackends(config, app.log, { hasPresidio, hasInjection });

  const maintenanceTimer = startBackgroundJobs(env, config, pool, app.log);
  installLifecycle({ app, pool, redis, maintenanceTimer });

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`modelgov listening on ${env.HOST}:${env.PORT}`);
}

main().catch((err) => {
  console.error(redactError(err));
  process.exit(1);
});
