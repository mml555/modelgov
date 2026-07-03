import type { ApiEnv, ApiKeyEnvPrincipal } from "./env";
import {
  assertDeployProfilePosture,
  deployProfileChecks,
} from "@modelgov/policy-engine";

/** Well-known keys shipped for local dev / CI smoke — must never run in production. */
export const KNOWN_DEV_API_KEYS = new Set([
  "sk-modelgov-api-local",
  "smoke-test-key",
]);

export const KNOWN_DEV_LANGFUSE_KEYS = new Set([
  "pk-lf-modelgov-local",
  "sk-lf-modelgov-local",
]);

const ADMIN_PERMISSIONS = new Set([
  "keys:admin",
  "policy:write",
  "data:erase",
]);

const WEAK_SECRET_PATTERNS = [
  /^REPLACE/i,
  /^changeme$/i,
  /^password$/i,
  /^secret$/i,
  /^test$/i,
  /^x+$/i,
];

/** Minimum length for production secrets (API keys, tokens). */
export const MIN_PRODUCTION_SECRET_LENGTH = 24;

function isWeakSecret(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length < MIN_PRODUCTION_SECRET_LENGTH) return true;
  return WEAK_SECRET_PATTERNS.some((re) => re.test(trimmed));
}

/** True when DATABASE_URL points at a non-local host (managed / remote Postgres). */
export function isRemoteDatabaseUrl(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl.replace(/^postgres(ql)?:/, "http:"));
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "postgres" ||
      host === "::1" ||
      host.endsWith(".local")
    ) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function hasAdminPermissions(principal: ApiKeyEnvPrincipal): boolean {
  const perms = principal.permissions ?? [];
  return perms.some((p) => ADMIN_PERMISSIONS.has(p));
}

/**
 * Fail fast on insecure production configuration. Called from the composition root
 * after env validation, before any network listeners or dependency wiring.
 */
export function assertProductionEnv(env: ApiEnv): void {
  if (env.MODELGOV_PRODUCTION !== "true") return;

  assertDeployProfilePosture(env as unknown as Record<string, string | undefined>);

  for (const principal of env.apiKeys) {
    if (principal.key && KNOWN_DEV_API_KEYS.has(principal.key)) {
      throw new Error(
        `MODELGOV production refuses known dev API key '${principal.name}' — set a strong random secret`,
      );
    }
    if (principal.key && isWeakSecret(principal.key)) {
      throw new Error(
        `MODELGOV production refuses weak API key '${principal.name}' — use at least ${MIN_PRODUCTION_SECRET_LENGTH} random characters`,
      );
    }
    if (
      principal.key &&
      hasAdminPermissions(principal) &&
      env.ALLOW_BOOTSTRAP_ADMIN_KEY !== "true"
    ) {
      throw new Error(
        `static env key '${principal.name}' has admin permissions — set ALLOW_BOOTSTRAP_ADMIN_KEY=true only for initial bootstrap, then rotate to DB-backed keys`,
      );
    }
  }

  if (env.METRICS_ENABLED === "true" && !env.METRICS_AUTH_TOKEN && env.METRICS_ALLOW_PUBLIC !== "true") {
    throw new Error(
      "METRICS_AUTH_TOKEN is required when METRICS_ENABLED=true in production (or set METRICS_ALLOW_PUBLIC=true to explicitly allow unauthenticated /metrics)",
    );
  }

  if (
    env.OBSERVABILITY_CAPTURE_CONTENT === "true" &&
    env.OBSERVABILITY_CAPTURE_CONTENT_ALLOW !== "true"
  ) {
    throw new Error(
      "OBSERVABILITY_CAPTURE_CONTENT=true in production requires OBSERVABILITY_CAPTURE_CONTENT_ALLOW=true",
    );
  }

  if (
    env.IDEMPOTENCY_CAPTURE_CONTENT === "true" &&
    env.IDEMPOTENCY_CAPTURE_CONTENT_ALLOW !== "true"
  ) {
    throw new Error(
      "IDEMPOTENCY_CAPTURE_CONTENT=true in production requires IDEMPOTENCY_CAPTURE_CONTENT_ALLOW=true",
    );
  }

  if (env.DATABASE_SSL === "disable") {
    if (env.DATABASE_SSL_DISABLE_ALLOWED !== "true") {
      throw new Error(
        "DATABASE_SSL=disable is not permitted when MODELGOV_PRODUCTION=true — use require or verify-full, or set DATABASE_SSL_DISABLE_ALLOWED=true only for bundled Postgres on a private network",
      );
    }
    if (isRemoteDatabaseUrl(env.DATABASE_URL)) {
      throw new Error(
        "DATABASE_SSL=disable is not permitted for remote DATABASE_URL hosts — use require or verify-full",
      );
    }
  }

  if (env.MODELGOV_BEHIND_PROXY === "true" && !env.TRUST_PROXY) {
    throw new Error(
      "MODELGOV_BEHIND_PROXY=true requires TRUST_PROXY to your load balancer IP/CIDR or hop count",
    );
  }

  if (
    env.LANGFUSE_PUBLIC_KEY &&
    KNOWN_DEV_LANGFUSE_KEYS.has(env.LANGFUSE_PUBLIC_KEY)
  ) {
    throw new Error(
      "LANGFUSE_PUBLIC_KEY is the dev-overlay default — set real Langfuse credentials or unset OBSERVABILITY_PROVIDER",
    );
  }
  if (
    env.LANGFUSE_SECRET_KEY &&
    KNOWN_DEV_LANGFUSE_KEYS.has(env.LANGFUSE_SECRET_KEY)
  ) {
    throw new Error(
      "LANGFUSE_SECRET_KEY is the dev-overlay default — set real Langfuse credentials or unset OBSERVABILITY_PROVIDER",
    );
  }

  if (env.METRICS_AUTH_TOKEN && isWeakSecret(env.METRICS_AUTH_TOKEN)) {
    throw new Error(
      `METRICS_AUTH_TOKEN is too weak — use at least ${MIN_PRODUCTION_SECRET_LENGTH} random characters`,
    );
  }

  if (env.OIDC_ISSUER && env.OIDC_JWKS_URI && !env.OIDC_AUDIENCE) {
    throw new Error(
      "OIDC_AUDIENCE is required when operator SSO is enabled in production",
    );
  }
}

export interface ProductionCheck {
  severity: "pass" | "warn" | "fail";
  code: string;
  message: string;
  fix?: string;
}

/** Offline production posture report for `modelgov doctor production`. */
export function productionDoctorChecks(env: Record<string, string>): ProductionCheck[] {
  const checks: ProductionCheck[] = [];
  const production = env.MODELGOV_PRODUCTION === "true";

  const push = (severity: ProductionCheck["severity"], code: string, message: string, fix?: string) => {
    checks.push({ severity, code, message, fix });
  };

  if (!production) {
    push("warn", "production_mode", "MODELGOV_PRODUCTION is not true", "Set MODELGOV_PRODUCTION=true for production deploys");
  }

  const apiKey = env.MODELGOV_API_KEY;
  if (apiKey && KNOWN_DEV_API_KEYS.has(apiKey)) {
    push("fail", "dev_api_key", "API key is a known dev default", "Generate a random secret and rotate all clients");
  } else if (apiKey && isWeakSecret(apiKey)) {
    push("fail", "weak_api_key", "API key is too short or matches a weak pattern", `Use at least ${MIN_PRODUCTION_SECRET_LENGTH} random characters`);
  } else if (apiKey) {
    push("pass", "api_key", "API key is not a known dev default");
  }

  if (env.METRICS_ENABLED === "true" && !env.METRICS_AUTH_TOKEN && env.METRICS_ALLOW_PUBLIC !== "true") {
    push("fail", "metrics_auth", "Metrics enabled without METRICS_AUTH_TOKEN", "Set METRICS_AUTH_TOKEN or METRICS_ALLOW_PUBLIC=true");
  } else if (env.METRICS_ENABLED === "true" && env.METRICS_AUTH_TOKEN) {
    push("pass", "metrics_auth", "Metrics auth token is configured");
  }

  if (env.DATABASE_SSL === "disable") {
    if (env.DATABASE_URL && isRemoteDatabaseUrl(env.DATABASE_URL)) {
      push("fail", "database_ssl", "DATABASE_SSL=disable with a remote host", "Set DATABASE_SSL=require or verify-full");
    } else if (env.DATABASE_SSL_DISABLE_ALLOWED !== "true") {
      push("fail", "database_ssl", "DATABASE_SSL=disable in production", "Use require/verify-full or DATABASE_SSL_DISABLE_ALLOWED=true for bundled Postgres only");
    } else {
      push("warn", "database_ssl", "DATABASE_SSL=disable explicitly allowed for local/bundled Postgres");
    }
  } else {
    push("pass", "database_ssl", `DATABASE_SSL=${env.DATABASE_SSL ?? "require"}`);
  }

  if (env.OBSERVABILITY_CAPTURE_CONTENT === "true" && env.OBSERVABILITY_CAPTURE_CONTENT_ALLOW !== "true") {
    push("fail", "obs_capture", "Observability content capture enabled without override", "Set OBSERVABILITY_CAPTURE_CONTENT=false or OBSERVABILITY_CAPTURE_CONTENT_ALLOW=true");
  }

  if (env.IDEMPOTENCY_CAPTURE_CONTENT === "true" && env.IDEMPOTENCY_CAPTURE_CONTENT_ALLOW !== "true") {
    push("fail", "idempotency_capture", "Idempotency content capture enabled without override", "Set IDEMPOTENCY_CAPTURE_CONTENT=false or IDEMPOTENCY_CAPTURE_CONTENT_ALLOW=true");
  }

  if (env.MODELGOV_BEHIND_PROXY === "true" && !env.TRUST_PROXY) {
    push("fail", "trust_proxy", "Behind proxy but TRUST_PROXY is unset", "Set TRUST_PROXY to your LB IP/CIDR or hop count");
  } else if (env.MODELGOV_BEHIND_PROXY === "true") {
    push("pass", "trust_proxy", "TRUST_PROXY configured for proxy mode");
  }

  if (
    (env.LANGFUSE_PUBLIC_KEY && KNOWN_DEV_LANGFUSE_KEYS.has(env.LANGFUSE_PUBLIC_KEY)) ||
    (env.LANGFUSE_SECRET_KEY && KNOWN_DEV_LANGFUSE_KEYS.has(env.LANGFUSE_SECRET_KEY))
  ) {
    push("fail", "langfuse_dev", "Langfuse dev-overlay credentials detected", "Use production Langfuse keys or OBSERVABILITY_PROVIDER=none");
  }

  if (env.OIDC_ISSUER && env.OIDC_JWKS_URI && !env.OIDC_AUDIENCE && env.OIDC_AUDIENCE_OPTIONAL !== "true") {
    push("fail", "oidc_audience", "OIDC enabled without OIDC_AUDIENCE", "Set OIDC_AUDIENCE to your client ID");
  }

  if (env.RATE_LIMIT_FAIL_OPEN === "true") {
    push("warn", "rate_limit_fail_open", "Rate limits fail open when Redis is unreachable", "Prefer RATE_LIMIT_FAIL_OPEN=false in production");
  }

  if (!env.REDIS_URL && production) {
    push("warn", "redis", "REDIS_URL not set — rate limits are per-replica only", "Configure managed Redis for multi-replica deploys");
  }

  for (const c of deployProfileChecks(env as unknown as Record<string, string | undefined>, {
    production,
  })) {
    push(c.severity, c.code, c.message, c.fix);
  }

  return checks;
}
