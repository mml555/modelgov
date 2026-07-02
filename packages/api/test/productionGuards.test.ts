import { describe, expect, it } from "vitest";
import {
  assertProductionEnv,
  isRemoteDatabaseUrl,
} from "../src/config/productionGuards";
import { loadEnv } from "../src/config/env";

function prodEnv(overrides: Record<string, string | undefined>): ReturnType<typeof loadEnv> {
  return loadEnv({
    DATABASE_URL: "postgres://u:p@localhost/db",
    AI_GUARD_CONFIG: "./ai-guard.yaml",
    LITELLM_BASE_URL: "http://localhost:4000",
    AI_GUARD_API_KEY: "sk-production-secret-key-12345",
    AI_GUARD_PRODUCTION: "true",
    METRICS_ENABLED: "true",
    METRICS_AUTH_TOKEN: "metrics-token-abcdefghijklmnopqrst",
    DATABASE_SSL: "require",
    ALLOW_BOOTSTRAP_ADMIN_KEY: "true",
    ...overrides,
  });
}

describe("isRemoteDatabaseUrl", () => {
  it("treats localhost and postgres as local", () => {
    expect(isRemoteDatabaseUrl("postgres://u:p@localhost/db")).toBe(false);
    expect(isRemoteDatabaseUrl("postgres://u:p@postgres:5432/db")).toBe(false);
  });
  it("treats RDS hosts as remote", () => {
    expect(isRemoteDatabaseUrl("postgres://u:p@mydb.abc123.us-east-1.rds.amazonaws.com/db")).toBe(true);
  });
});

describe("assertProductionEnv", () => {
  it("accepts a valid production configuration", () => {
    expect(() => assertProductionEnv(prodEnv({}))).not.toThrow();
  });

  it("refuses known dev API keys", () => {
    expect(() =>
      assertProductionEnv(prodEnv({ AI_GUARD_API_KEY: "sk-ai-guard-api-local", ALLOW_BOOTSTRAP_ADMIN_KEY: "true" })),
    ).toThrow(/known dev API key/);
  });

  it("refuses metrics without auth token unless explicitly allowed", () => {
    expect(() =>
      assertProductionEnv(
        loadEnv({
          DATABASE_URL: "postgres://u:p@localhost/db",
          AI_GUARD_CONFIG: "./ai-guard.yaml",
          LITELLM_BASE_URL: "http://localhost:4000",
          AI_GUARD_API_KEY: "sk-production-secret-key-12345",
          AI_GUARD_PRODUCTION: "true",
          METRICS_ENABLED: "true",
          DATABASE_SSL: "require",
        }),
      ),
    ).toThrow(/METRICS_AUTH_TOKEN/);
    expect(() =>
      assertProductionEnv(prodEnv({ METRICS_AUTH_TOKEN: undefined, METRICS_ALLOW_PUBLIC: "true" })),
    ).not.toThrow();
  });

  it("refuses DATABASE_SSL=disable without override", () => {
    expect(() =>
      assertProductionEnv(prodEnv({ DATABASE_SSL: "disable" })),
    ).toThrow(/DATABASE_SSL/);
  });

  it("allows DATABASE_SSL=disable for bundled postgres with override", () => {
    expect(() =>
      assertProductionEnv(
        prodEnv({
          DATABASE_URL: "postgres://u:p@postgres:5432/db",
          DATABASE_SSL: "disable",
          DATABASE_SSL_DISABLE_ALLOWED: "true",
        }),
      ),
    ).not.toThrow();
  });

  it("refuses DATABASE_SSL=disable for remote hosts", () => {
    expect(() =>
      assertProductionEnv(
        prodEnv({
          DATABASE_URL: "postgres://u:p@db.example.com:5432/db",
          DATABASE_SSL: "disable",
          DATABASE_SSL_DISABLE_ALLOWED: "true",
        }),
      ),
    ).toThrow(/remote/);
  });

  it("refuses content capture without explicit allow", () => {
    expect(() =>
      assertProductionEnv(prodEnv({ OBSERVABILITY_CAPTURE_CONTENT: "true" })),
    ).toThrow(/OBSERVABILITY_CAPTURE_CONTENT_ALLOW/);
  });

  it("refuses static admin keys without bootstrap flag", () => {
    expect(() =>
      assertProductionEnv(
        loadEnv({
          DATABASE_URL: "postgres://u:p@localhost/db",
          AI_GUARD_CONFIG: "./ai-guard.yaml",
          LITELLM_BASE_URL: "http://localhost:4000",
          AI_GUARD_PRODUCTION: "true",
          METRICS_ENABLED: "true",
          METRICS_AUTH_TOKEN: "metrics-token-abcdefghijklmnopqrst",
          DATABASE_SSL: "require",
          AI_GUARD_API_KEYS: JSON.stringify([
            { name: "admin", key: "sk-bootstrap-admin-key-1234567890", permissions: ["keys:admin"] },
          ]),
        }),
      ),
    ).toThrow(/ALLOW_BOOTSTRAP_ADMIN_KEY/);
  });

  it("refuses OIDC without audience", () => {
    expect(() =>
      assertProductionEnv(
        prodEnv({
          OIDC_ISSUER: "https://login.example.com/",
          OIDC_JWKS_URI: "https://login.example.com/.well-known/jwks.json",
        }),
      ),
    ).toThrow(/OIDC_AUDIENCE/);
  });

  it("requires TRUST_PROXY when behind proxy", () => {
    expect(() =>
      assertProductionEnv(prodEnv({ AI_GUARD_BEHIND_PROXY: "true" })),
    ).toThrow(/TRUST_PROXY/);
  });

  it("refuses multitenant profile without DB_RLS in production", () => {
    expect(() =>
      assertProductionEnv(
        prodEnv({
          AI_GUARD_DEPLOY_PROFILE: "multitenant",
          POLICY_STORE_ENABLED: "true",
          MULTI_TENANT_POLICY: "true",
          DB_RLS_ENABLED: "false",
        }),
      ),
    ).toThrow(/Deploy profile posture failed/);
  });

  it("accepts multitenant profile when policy flags match", () => {
    expect(() =>
      assertProductionEnv(
        prodEnv({
          AI_GUARD_DEPLOY_PROFILE: "multitenant",
          POLICY_STORE_ENABLED: "true",
          MULTI_TENANT_POLICY: "true",
          DB_RLS_ENABLED: "true",
        }),
      ),
    ).not.toThrow();
  });

  it("is a no-op when AI_GUARD_PRODUCTION is false", () => {
    expect(() =>
      assertProductionEnv(
        loadEnv({
          DATABASE_URL: "postgres://u:p@localhost/db",
          AI_GUARD_CONFIG: "./ai-guard.yaml",
          LITELLM_BASE_URL: "http://localhost:4000",
          AI_GUARD_API_KEY: "sk-ai-guard-api-local",
          AI_GUARD_PRODUCTION: "false",
          DATABASE_SSL: "disable",
        }),
      ),
    ).not.toThrow();
  });
});
