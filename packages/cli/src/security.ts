import { deployProfileChecks } from "@modelgov/policy-engine";

const KNOWN_DEV_API_KEYS = new Set(["sk-modelgov-api-local", "smoke-test-key"]);

/**
 * Security posture checks for operator env files. Returns human-readable lines
 * (prefixed ok/warn/fail) suitable for `doctor` output.
 */
export function securityConfigWarnings(env: Record<string, string>): string[] {
  const lines: string[] = [];

  const apiKey = env.MODELGOV_API_KEY;
  if (apiKey && KNOWN_DEV_API_KEYS.has(apiKey)) {
    lines.push("warn API key is a known dev default — rotate before shared or staging deploys");
  }

  if (env.OIDC_ISSUER && env.OIDC_JWKS_URI && !env.OIDC_AUDIENCE && env.OIDC_AUDIENCE_OPTIONAL !== "true") {
    lines.push(
      "warn OIDC enabled without OIDC_AUDIENCE — set OIDC_AUDIENCE or OIDC_AUDIENCE_OPTIONAL=true (local dev only)",
    );
  }

  if (env.RATE_LIMIT_FAIL_OPEN === "true") {
    lines.push("warn RATE_LIMIT_FAIL_OPEN=true — rate limits are bypassed when Redis is unreachable");
  }

  for (const c of deployProfileChecks(env, { production: env.MODELGOV_PRODUCTION === "true" })) {
    if (c.severity === "pass") continue;
    lines.push(`${c.severity} ${c.message}`);
  }

  if (env.MODELGOV_PRODUCTION === "true") {
    if (env.DATABASE_SSL === "disable" && env.DATABASE_SSL_DISABLE_ALLOWED !== "true") {
      lines.push("fail DATABASE_SSL=disable is not permitted when MODELGOV_PRODUCTION=true (set DATABASE_SSL_DISABLE_ALLOWED=true only for bundled Postgres)");
    }
    if (env.METRICS_ENABLED === "true" && !env.METRICS_AUTH_TOKEN && env.METRICS_ALLOW_PUBLIC !== "true") {
      lines.push("fail METRICS_AUTH_TOKEN is required when METRICS_ENABLED=true in production (or METRICS_ALLOW_PUBLIC=true)");
    }
    if (apiKey && KNOWN_DEV_API_KEYS.has(apiKey)) {
      lines.push("fail known dev API key cannot be used with MODELGOV_PRODUCTION=true");
    }
    if (env.OBSERVABILITY_CAPTURE_CONTENT === "true" && env.OBSERVABILITY_CAPTURE_CONTENT_ALLOW !== "true") {
      lines.push("fail OBSERVABILITY_CAPTURE_CONTENT=true requires OBSERVABILITY_CAPTURE_CONTENT_ALLOW=true in production");
    }
    if (env.IDEMPOTENCY_CAPTURE_CONTENT === "true" && env.IDEMPOTENCY_CAPTURE_CONTENT_ALLOW !== "true") {
      lines.push("fail IDEMPOTENCY_CAPTURE_CONTENT=true requires IDEMPOTENCY_CAPTURE_CONTENT_ALLOW=true in production");
    }
    // parseTrustProxy() treats "false" as disabled, so an explicit
    // TRUST_PROXY=false leaves proxy trust off — reject it like an unset value.
    if (env.MODELGOV_BEHIND_PROXY === "true" && (!env.TRUST_PROXY || env.TRUST_PROXY === "false")) {
      lines.push("fail MODELGOV_BEHIND_PROXY=true requires TRUST_PROXY");
    }
  }

  return lines;
}

/** Throw when env fails production deploy checks (lines prefixed with `fail`). */
export function assertProductionDeploy(env: Record<string, string>): void {
  const failures = securityConfigWarnings(env).filter((line) => line.startsWith("fail "));
  if (failures.length === 0) return;
  throw new Error(`production deploy checks failed:\n${failures.map((l) => `  ${l}`).join("\n")}`);
}
