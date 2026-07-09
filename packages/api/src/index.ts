import { loadEnv } from "./config/env";
import { assertProductionEnv } from "./config/productionGuards";
import { setPolicyEnvRefAllowlist, warnUnpricedModels } from "./config/loadConfig";
import {
  frozenPolicyFieldsFingerprint,
  setConfigVersionsRls,
  setConfigVersionsStrictPricing,
} from "./modules/policy/repo";
import { buildServer } from "./app";
import { createDocumentClient } from "./services/documents";
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
  startPolicyListener,
  warnGroundingPiiExposure,
  warnMissingSafetyBackends,
} from "./bootstrap";
import { createBillingService } from "./modules/billing/service";

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
  // Store-path config validation must honor STRICT_PRICING too (the file loader
  // already does), so a version adding an unpriced model is rejected, not run at
  // DEFAULT_PRICE.
  setConfigVersionsStrictPricing(env.STRICT_PRICING === "true");
  // Restrict which env vars a policy `env/VAR` provider key may resolve (defense
  // against a policy:write operator referencing a gateway secret). Must run
  // before resolvePolicy, which resolves the file/store config's env refs.
  setPolicyEnvRefAllowlist(parseCsv(env.MODELGOV_POLICY_ENV_ALLOWLIST) ?? []);
  const { config, policyMeta } = await resolvePolicy(env, pool);
  const tenantPolicy = createPolicyResolver(env, pool, { config, policyMeta }, {
    warn: (obj, msg) => console.warn(msg, obj),
    error: (obj, msg) => console.error(msg, obj),
  });
  const { litellm, safety, observability, hasPresidio, hasInjection } =
    createRuntimeServices(env, config);
  const redis = await connectRedisIfConfigured(env);
  const budgetAlert = resolveBudgetAlert(env);
  const billing = createBillingService(pool, {
    billing: config.billing,
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
  });
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
    // Force-settle a stream before its reservation could go stale and be swept
    // mid-flight (which would leave it unbilled). Kept a margin below
    // RESERVATION_STALE_MS; floored so a small stale window still leaves room.
    streamMaxDurationMs: Math.max(60_000, env.RESERVATION_STALE_MS - env.LITELLM_TIMEOUT_MS),
    policyMeta,
    tenantPolicy,
    policyApprovalRequired: env.POLICY_APPROVAL_REQUIRED === "true",
    // Boot fingerprint of the non-hot-reloadable fields; the policy route refuses
    // to hot-activate a version that changes them (would otherwise half-apply).
    policyFrozenFieldsFingerprint: frozenPolicyFieldsFingerprint(config),
    idempotencyCaptureContent: env.IDEMPOTENCY_CAPTURE_CONTENT === "true",
    metrics: env.METRICS_ENABLED === "true",
    metricsAuthToken: env.METRICS_AUTH_TOKEN,
    logLevel: env.LOG_LEVEL,
    production: env.MODELGOV_PRODUCTION === "true",
    corsAllowOrigins: parseCsv(env.CORS_ALLOW_ORIGINS),
    bodyLimitBytes: env.REQUEST_BODY_LIMIT_BYTES,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    externalCost: {
      sources: parseCsv(env.EXTERNAL_COST_SOURCES) ?? [],
      maxUsd: env.EXTERNAL_COST_MAX_USD,
    },
    // Governed document-AI providers (second egress). Each provider is enabled
    // only when its endpoint/credentials are configured.
    documentClient: createDocumentClient({
      tesseract: env.TESSERACT_URL
        ? { url: env.TESSERACT_URL, perPageUsd: env.DOCUMENT_PRICE_PER_PAGE_TESSERACT }
        : undefined,
      azureDi:
        env.AZURE_DI_ENDPOINT && env.AZURE_DI_KEY
          ? {
              endpoint: env.AZURE_DI_ENDPOINT,
              key: env.AZURE_DI_KEY,
              perPageUsd: env.DOCUMENT_PRICE_PER_PAGE_AZURE_DI,
              apiVersion: env.AZURE_DI_API_VERSION,
            }
          : undefined,
      // Enabled only with an explicit TEXTRACT_REGION (so generic AWS creds
      // present for other reasons don't silently turn Textract on) + creds.
      textract:
        env.TEXTRACT_REGION && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? {
              region: env.TEXTRACT_REGION,
              accessKeyId: env.AWS_ACCESS_KEY_ID,
              secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
              sessionToken: env.AWS_SESSION_TOKEN,
              perPageUsd: env.DOCUMENT_PRICE_PER_PAGE_TEXTRACT,
              s3AllowedBuckets: parseCsv(env.TEXTRACT_S3_ALLOWED_BUCKETS) ?? [],
            }
          : undefined,
    }),
    documentMaxPages: env.DOCUMENT_MAX_PAGES,
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
    billing,
  });

  if (redis) app.log.info("rate limiting backed by Redis");
  warnUnpricedModels(config, app.log);
  warnMissingSafetyBackends(config, app.log, { hasPresidio, hasInjection });
  warnGroundingPiiExposure(config, app.log);

  const maintenanceTimer = startBackgroundJobs(env, config, pool, app.log, billing);
  // Hot reload: invalidate this replica's policy cache the instant any replica
  // activates a version (TTL cache is the backstop). No-op on the boot-config path.
  const policyListener = startPolicyListener(env, tenantPolicy, app.log);
  installLifecycle({ app, pool, redis, maintenanceTimer, policyListener });

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`modelgov listening on ${env.HOST}:${env.PORT}`);
}

main().catch((err) => {
  console.error(redactError(err));
  process.exit(1);
});
