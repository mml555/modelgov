/**
 * Shared production-posture checks over environment strings, consumed by BOTH
 * the API boot guard (`assertProductionEnv`, which throws on any "fail") and the
 * CLI offline doctor (`productionDoctorChecksFromEnv`, which renders the full
 * pass/warn/fail list). Single-sourced here so a new rule can never land in one
 * and be silently forgotten in the other — the doctor's entire job is to
 * predict, offline, what the server will refuse to boot with.
 *
 * Pure — no I/O. Covers only the env-string rules common to both callers; each
 * caller keeps its own extras (the boot guard additionally validates structured
 * API-key principals; the doctor adds advisory warnings like Redis / rate-limit
 * fail-open and the single-key `MODELGOV_API_KEY` check).
 */
import type { DeployProfileCheck } from "./deployProfiles";

/** Well-known keys shipped for local dev / CI smoke — must never run in production. */
export const KNOWN_DEV_API_KEYS = new Set(["sk-modelgov-api-local", "smoke-test-key"]);

export const KNOWN_DEV_LANGFUSE_KEYS = new Set([
  "pk-lf-modelgov-local",
  "sk-lf-modelgov-local",
]);

/** Minimum length for production secrets (API keys, tokens). */
export const MIN_PRODUCTION_SECRET_LENGTH = 24;

const WEAK_SECRET_PATTERNS = [
  /^REPLACE/i,
  /^changeme$/i,
  /^password$/i,
  /^secret$/i,
  /^test$/i,
  /^x+$/i,
];

export function isWeakSecret(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length < MIN_PRODUCTION_SECRET_LENGTH) return true;
  return WEAK_SECRET_PATTERNS.some((re) => re.test(trimmed));
}

/** True when DATABASE_URL points at a non-local host (managed / remote Postgres). */
export function isRemoteDatabaseUrl(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl.replace(/^postgres(ql)?:/, "http:"));
    const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
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

/**
 * Env-string production-posture checks. Messages deliberately embed the relevant
 * env var name(s) so both the boot-guard error and the doctor report are
 * self-explanatory (and so the boot-guard test can assert on them).
 */
export function productionPostureChecks(
  env: Record<string, string | undefined>,
): DeployProfileCheck[] {
  const checks: DeployProfileCheck[] = [];
  const push = (
    severity: DeployProfileCheck["severity"],
    code: string,
    message: string,
    fix?: string,
  ) => {
    checks.push({ severity, code, message, fix });
  };

  // ── Metrics auth ──────────────────────────────────────────────────────────
  if (
    env.METRICS_ENABLED === "true" &&
    !env.METRICS_AUTH_TOKEN &&
    env.METRICS_ALLOW_PUBLIC !== "true"
  ) {
    push(
      "fail",
      "metrics_auth",
      "METRICS_AUTH_TOKEN is required when METRICS_ENABLED=true in production",
      "Set METRICS_AUTH_TOKEN, or METRICS_ALLOW_PUBLIC=true to explicitly allow unauthenticated /metrics",
    );
  } else if (env.METRICS_AUTH_TOKEN && isWeakSecret(env.METRICS_AUTH_TOKEN)) {
    push(
      "fail",
      "metrics_auth",
      "METRICS_AUTH_TOKEN is too weak",
      `Use at least ${MIN_PRODUCTION_SECRET_LENGTH} random characters`,
    );
  } else if (env.METRICS_ENABLED === "true" && env.METRICS_AUTH_TOKEN) {
    push("pass", "metrics_auth", "Metrics auth token is configured");
  }

  // ── Database TLS ──────────────────────────────────────────────────────────
  if (env.DATABASE_SSL === "disable") {
    if (env.DATABASE_URL && isRemoteDatabaseUrl(env.DATABASE_URL)) {
      push(
        "fail",
        "database_ssl",
        "DATABASE_SSL=disable is not permitted for a remote DATABASE_URL host",
        "Use DATABASE_SSL=require or verify-full",
      );
    } else if (env.DATABASE_SSL_DISABLE_ALLOWED !== "true") {
      push(
        "fail",
        "database_ssl",
        "DATABASE_SSL=disable is not permitted in production",
        "Use require/verify-full, or set DATABASE_SSL_DISABLE_ALLOWED=true only for bundled Postgres on a private network",
      );
    } else {
      push("warn", "database_ssl", "DATABASE_SSL=disable explicitly allowed for local/bundled Postgres");
    }
  } else if (
    env.DATABASE_SSL === "require" &&
    env.DATABASE_URL &&
    isRemoteDatabaseUrl(env.DATABASE_URL) &&
    env.DATABASE_SSL_NO_VERIFY_ALLOWED !== "true"
  ) {
    // `require` encrypts but does NOT verify the server certificate, so a remote
    // connection is MITM-able. It reads as "secure TLS" but isn't.
    push(
      "fail",
      "database_ssl",
      "DATABASE_SSL=require does not verify the Postgres server certificate (MITM-able) for a remote DATABASE_URL host",
      "Use DATABASE_SSL=verify-full (set DATABASE_SSL_CA if the CA isn't in the system trust store), or DATABASE_SSL_NO_VERIFY_ALLOWED=true only for a trusted private network",
    );
  } else {
    push("pass", "database_ssl", `DATABASE_SSL=${env.DATABASE_SSL ?? "require"}`);
  }

  // ── Content capture (observability + idempotency) ─────────────────────────
  if (
    env.OBSERVABILITY_CAPTURE_CONTENT === "true" &&
    env.OBSERVABILITY_CAPTURE_CONTENT_ALLOW !== "true"
  ) {
    push(
      "fail",
      "obs_capture",
      "OBSERVABILITY_CAPTURE_CONTENT=true in production requires OBSERVABILITY_CAPTURE_CONTENT_ALLOW=true",
      "Set OBSERVABILITY_CAPTURE_CONTENT=false or OBSERVABILITY_CAPTURE_CONTENT_ALLOW=true",
    );
  }
  if (
    env.IDEMPOTENCY_CAPTURE_CONTENT === "true" &&
    env.IDEMPOTENCY_CAPTURE_CONTENT_ALLOW !== "true"
  ) {
    push(
      "fail",
      "idempotency_capture",
      "IDEMPOTENCY_CAPTURE_CONTENT=true in production requires IDEMPOTENCY_CAPTURE_CONTENT_ALLOW=true",
      "Set IDEMPOTENCY_CAPTURE_CONTENT=false or IDEMPOTENCY_CAPTURE_CONTENT_ALLOW=true",
    );
  }

  // ── Reverse-proxy trust ───────────────────────────────────────────────────
  if (env.MODELGOV_BEHIND_PROXY === "true" && !env.TRUST_PROXY) {
    push(
      "fail",
      "trust_proxy",
      "MODELGOV_BEHIND_PROXY=true requires TRUST_PROXY to your load balancer IP/CIDR or hop count",
      "Set TRUST_PROXY to your LB IP/CIDR or hop count",
    );
  } else if (env.MODELGOV_BEHIND_PROXY === "true") {
    push("pass", "trust_proxy", "TRUST_PROXY configured for proxy mode");
  }

  // ── Langfuse dev-overlay credentials ──────────────────────────────────────
  if (
    (env.LANGFUSE_PUBLIC_KEY && KNOWN_DEV_LANGFUSE_KEYS.has(env.LANGFUSE_PUBLIC_KEY)) ||
    (env.LANGFUSE_SECRET_KEY && KNOWN_DEV_LANGFUSE_KEYS.has(env.LANGFUSE_SECRET_KEY))
  ) {
    push(
      "fail",
      "langfuse_dev",
      "Langfuse dev-overlay credentials detected",
      "Use production Langfuse keys or set OBSERVABILITY_PROVIDER=none",
    );
  }

  // ── Operator SSO audience ─────────────────────────────────────────────────
  // createAuthProviders throws in production when operator SSO is enabled without
  // an audience REGARDLESS of OIDC_AUDIENCE_OPTIONAL — the flag is a local-dev
  // escape only. The doctor/boot guard must mirror that exactly, or `doctor
  // production` reports green for a config the server then refuses to boot.
  if (env.OIDC_ISSUER && env.OIDC_JWKS_URI && !env.OIDC_AUDIENCE) {
    if (env.MODELGOV_PRODUCTION === "true" || env.OIDC_AUDIENCE_OPTIONAL !== "true") {
      push(
        "fail",
        "oidc_audience",
        "OIDC_AUDIENCE is required when operator SSO is enabled in production",
        "Set OIDC_AUDIENCE to your client ID (OIDC_AUDIENCE_OPTIONAL is a non-production escape only)",
      );
    } else {
      // Non-production with the escape flag set: token aud is not bound.
      push(
        "warn",
        "oidc_audience",
        "OIDC audience validation disabled via OIDC_AUDIENCE_OPTIONAL — operator JWTs are not bound to an audience (token-confusion risk); production requires OIDC_AUDIENCE",
        "Set OIDC_AUDIENCE to your client ID",
      );
    }
  }

  // ── Operator SSO role mapping ─────────────────────────────────────────────
  // Without OIDC_ROLE_MAP the IdP's role/group claim values are used as modelgov
  // role names VERBATIM, so an IdP group literally named "owner" grants the owner
  // role (tenant:switch, keys:admin, data:erase, policy:*). Production must map
  // groups explicitly; dev gets a warning. Mirrors createAuthProviders.
  if (env.OIDC_ISSUER && env.OIDC_JWKS_URI && !env.OIDC_ROLE_MAP) {
    if (env.MODELGOV_PRODUCTION === "true") {
      push(
        "fail",
        "oidc_role_map",
        "OIDC_ROLE_MAP is required when operator SSO is enabled in production",
        'Map IdP groups to modelgov roles explicitly (e.g. {"platform-admins":"owner"}); without it an IdP group named "owner" grants the owner role',
      );
    } else {
      push(
        "warn",
        "oidc_role_map",
        "OIDC_ROLE_MAP is unset — IdP role/group claim values are treated as modelgov role names verbatim (an IdP group named 'owner' grants owner)",
        "Set OIDC_ROLE_MAP to map IdP groups to roles explicitly",
      );
    }
  }

  return checks;
}
