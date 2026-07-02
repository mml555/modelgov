/** Offline production posture checks for `ai-guard doctor production`. */

import { deployProfileChecks } from "@ai-guard/policy-engine";

export interface ProductionCheck {
  severity: "pass" | "warn" | "fail";
  code: string;
  message: string;
  fix?: string;
}

const KNOWN_DEV_API_KEYS = new Set(["sk-ai-guard-api-local", "smoke-test-key"]);
const KNOWN_DEV_LANGFUSE = new Set(["pk-lf-ai-guard-local", "sk-lf-ai-guard-local"]);
const MIN_SECRET = 24;

function isWeakSecret(value: string | undefined): boolean {
  if (!value) return false;
  const t = value.trim();
  if (t.length < MIN_SECRET) return true;
  return /^(REPLACE|changeme|password|secret|test|x+)$/i.test(t);
}

function isRemoteDatabaseUrl(url: string): boolean {
  try {
    const u = new URL(url.replace(/^postgres(ql)?:/, "http:"));
    const h = u.hostname.toLowerCase();
    return !["localhost", "127.0.0.1", "postgres", "::1"].includes(h) && !h.endsWith(".local");
  } catch {
    return true;
  }
}

export function productionDoctorChecksFromEnv(env: Record<string, string>): ProductionCheck[] {
  const checks: ProductionCheck[] = [];
  const push = (severity: ProductionCheck["severity"], code: string, message: string, fix?: string) => {
    checks.push({ severity, code, message, fix });
  };

  if (env.AI_GUARD_PRODUCTION !== "true") {
    push("warn", "production_mode", "AI_GUARD_PRODUCTION is not true", "Set AI_GUARD_PRODUCTION=true");
  }

  const apiKey = env.AI_GUARD_API_KEY;
  if (apiKey && KNOWN_DEV_API_KEYS.has(apiKey)) {
    push("fail", "dev_api_key", "API key is a known dev default", "Generate a random secret");
  } else if (apiKey && isWeakSecret(apiKey)) {
    push("fail", "weak_api_key", "API key is too short or weak", `Use at least ${MIN_SECRET} random characters`);
  } else if (apiKey) {
    push("pass", "api_key", "API key is not a known dev default");
  }

  if (env.METRICS_ENABLED === "true" && !env.METRICS_AUTH_TOKEN && env.METRICS_ALLOW_PUBLIC !== "true") {
    push("fail", "metrics_auth", "Metrics enabled without METRICS_AUTH_TOKEN", "Set METRICS_AUTH_TOKEN or METRICS_ALLOW_PUBLIC=true");
  } else if (env.METRICS_ENABLED === "true" && env.METRICS_AUTH_TOKEN) {
    push("pass", "metrics_auth", "Metrics auth token configured");
  }

  if (env.DATABASE_SSL === "disable") {
    if (env.DATABASE_URL && isRemoteDatabaseUrl(env.DATABASE_URL)) {
      push("fail", "database_ssl", "DATABASE_SSL=disable with remote host", "Use require or verify-full");
    } else if (env.DATABASE_SSL_DISABLE_ALLOWED !== "true") {
      push("fail", "database_ssl", "DATABASE_SSL=disable in production", "Use require/verify-full or DATABASE_SSL_DISABLE_ALLOWED=true for bundled Postgres");
    } else {
      push("warn", "database_ssl", "DATABASE_SSL=disable allowed for local/bundled Postgres");
    }
  } else {
    push("pass", "database_ssl", `DATABASE_SSL=${env.DATABASE_SSL ?? "require"}`);
  }

  if (env.OBSERVABILITY_CAPTURE_CONTENT === "true" && env.OBSERVABILITY_CAPTURE_CONTENT_ALLOW !== "true") {
    push("fail", "obs_capture", "Observability content capture without override", "Set OBSERVABILITY_CAPTURE_CONTENT=false or ALLOW=true");
  }

  if (env.IDEMPOTENCY_CAPTURE_CONTENT === "true" && env.IDEMPOTENCY_CAPTURE_CONTENT_ALLOW !== "true") {
    push("fail", "idempotency_capture", "Idempotency content capture without override", "Set IDEMPOTENCY_CAPTURE_CONTENT=false or ALLOW=true");
  }

  if (env.AI_GUARD_BEHIND_PROXY === "true" && !env.TRUST_PROXY) {
    push("fail", "trust_proxy", "Behind proxy but TRUST_PROXY unset", "Set TRUST_PROXY to LB CIDR");
  }

  if (
    (env.LANGFUSE_PUBLIC_KEY && KNOWN_DEV_LANGFUSE.has(env.LANGFUSE_PUBLIC_KEY)) ||
    (env.LANGFUSE_SECRET_KEY && KNOWN_DEV_LANGFUSE.has(env.LANGFUSE_SECRET_KEY))
  ) {
    push("fail", "langfuse_dev", "Langfuse dev credentials detected", "Use production keys or OBSERVABILITY_PROVIDER=none");
  }

  if (env.OIDC_ISSUER && env.OIDC_JWKS_URI && !env.OIDC_AUDIENCE && env.OIDC_AUDIENCE_OPTIONAL !== "true") {
    push("fail", "oidc_audience", "OIDC without OIDC_AUDIENCE", "Set OIDC_AUDIENCE");
  }

  if (env.RATE_LIMIT_FAIL_OPEN === "true") {
    push("warn", "rate_limit_fail_open", "Rate limits fail open when Redis unreachable");
  }

  if (!env.REDIS_URL && env.AI_GUARD_PRODUCTION === "true") {
    push("warn", "redis", "REDIS_URL not set — per-replica rate limits only", "Configure managed Redis for multi-replica");
  }

  for (const c of deployProfileChecks(env, { production: env.AI_GUARD_PRODUCTION === "true" })) {
    push(c.severity, c.code, c.message, c.fix);
  }

  return checks;
}
