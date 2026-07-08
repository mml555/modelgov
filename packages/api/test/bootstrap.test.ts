import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertPublicHttpUrl,
  connectRedisIfConfigured,
  createAuthProviders,
  createPolicyResolver,
  createRuntimeServices,
  parseCsv,
  parseTrustProxy,
  redactError,
  resolveBudgetAlert,
  resolvePolicy,
  startBackgroundJobs,
  startPolicyListener,
  warnMissingSafetyBackends,
} from "../src/bootstrap";
import { assertProductionEnv } from "../src/config/productionGuards";
import { loadEnv } from "../src/config/env";
import { parseConfigObject } from "@modelgov/policy-engine";
import { mockPool } from "./mockPool";

const config = parseConfigObject({
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 100, hard_stop_at_percent: 100 },
    by_user_type: { logged_in: { daily_usd: 1, daily_requests: 10, models: ["cheap"] } },
  },
  features: { support_chat: { safety: "dev", model_class: "cheap", max_tokens: 100 } },
  model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
  safety: { preset: "dev" },
});

describe("createRuntimeServices production guard", () => {
  it("refuses dev Langfuse credentials when MODELGOV_PRODUCTION=true", () => {
    expect(() =>
      createRuntimeServices(
        {
          LITELLM_BASE_URL: "http://localhost:4000",
          LANGFUSE_PUBLIC_KEY: "pk-lf-modelgov-local",
          LANGFUSE_SECRET_KEY: "sk-lf-modelgov-local",
          MODELGOV_PRODUCTION: "true",
        } as never,
        config,
      ),
    ).toThrow(/dev-overlay defaults/);
  });
});

describe("assertProductionEnv integration", () => {
  it("refuses smoke-test-key in production", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "smoke-test-key",
      MODELGOV_PRODUCTION: "true",
      METRICS_ENABLED: "false",
      DATABASE_SSL: "require",
    });
    expect(() => assertProductionEnv(env)).toThrow(/known dev API key/);
  });
});

describe("bootstrap helpers", () => {
  it("redactError strips postgres URLs from messages", () => {
    const msg = redactError(new Error("connect failed postgres://user:secret@host/db"));
    expect(msg).not.toContain("secret");
    expect(msg).toContain("postgres://[redacted]");
  });

  it("parseTrustProxy defaults to false", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("10.0.0.1,10.0.0.2")).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("parseCsv splits and trims", () => {
    expect(parseCsv(undefined)).toBeUndefined();
    expect(parseCsv("  ")).toBeUndefined();
    expect(parseCsv("a, b ,c")).toEqual(["a", "b", "c"]);
  });

  it("assertPublicHttpUrl rejects private webhook hosts", () => {
    expect(() => assertPublicHttpUrl("http://127.0.0.1/hook")).toThrow(/private/);
    expect(() => assertPublicHttpUrl("ftp://example.com/h")).toThrow(/http\(s\)/);
    expect(() => assertPublicHttpUrl("https://hooks.example.com/alert")).not.toThrow();
  });

  it("resolveBudgetAlert validates public URLs by default", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-test-key-1234567890",
      BUDGET_ALERT_WEBHOOK_URL: "https://hooks.example.com/budget",
      BUDGET_ALERT_WEBHOOK_SECRET: "s3cret",
    });
    const cfg = resolveBudgetAlert(env);
    expect(cfg?.url).toBe("https://hooks.example.com/budget");
  });

  it("connectRedisIfConfigured returns undefined when REDIS_URL is unset", async () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-test-key-1234567890",
    });
    await expect(connectRedisIfConfigured(env)).resolves.toBeUndefined();
  });

  it("connectRedisIfConfigured throws when Redis is unreachable", async () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-test-key-1234567890",
      REDIS_URL: "redis://127.0.0.1:6399",
    });
    await expect(connectRedisIfConfigured(env)).rejects.toThrow(/Redis unreachable/);
  }, 10_000);

  it("resolveBudgetAlert rejects private URLs unless explicitly allowed", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-test-key-1234567890",
      BUDGET_ALERT_WEBHOOK_URL: "http://10.0.0.1/hook",
    });
    expect(() => resolveBudgetAlert(env)).toThrow(/private/);
    const allowed = loadEnv({
      ...{
        DATABASE_URL: "postgres://u:p@localhost/db",
        MODELGOV_CONFIG: "./modelgov.yaml",
        LITELLM_BASE_URL: "http://localhost:4000",
        MODELGOV_API_KEY: "sk-test-key-1234567890",
      },
      BUDGET_ALERT_WEBHOOK_URL: "http://10.0.0.1/hook",
      BUDGET_ALERT_WEBHOOK_ALLOW_PRIVATE: "true",
    });
    expect(resolveBudgetAlert(allowed)?.url).toBe("http://10.0.0.1/hook");
  });
});

describe("createAuthProviders OIDC audience", () => {
  it("throws in production when OIDC is configured without audience", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-production-secret-key-12345",
      MODELGOV_PRODUCTION: "true",
      OIDC_ISSUER: "https://login.example.com/",
      OIDC_JWKS_URI: "https://login.example.com/.well-known/jwks.json",
    });
    expect(() => createAuthProviders(env, mockPool() as never)).toThrow(/OIDC_AUDIENCE/);
  });

  it("throws in non-production when OIDC lacks audience and optional flag is off", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-production-secret-key-12345",
      OIDC_ISSUER: "https://login.example.com/",
      OIDC_JWKS_URI: "https://login.example.com/.well-known/jwks.json",
    });
    expect(() => createAuthProviders(env, mockPool() as never)).toThrow(/OIDC_AUDIENCE/);
  });

  it("allows non-production OIDC without audience when OIDC_AUDIENCE_OPTIONAL=true", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-production-secret-key-12345",
      OIDC_ISSUER: "https://login.example.com/",
      OIDC_JWKS_URI: "https://login.example.com/.well-known/jwks.json",
      OIDC_AUDIENCE_OPTIONAL: "true",
    });
    const { jwtVerifier } = createAuthProviders(env, mockPool() as never);
    expect(jwtVerifier).toBeDefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("throws when OIDC_ROLE_MAP is invalid JSON", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-production-secret-key-12345",
      OIDC_ISSUER: "https://login.example.com/",
      OIDC_JWKS_URI: "https://login.example.com/.well-known/jwks.json",
      OIDC_AUDIENCE: "modelgov",
      OIDC_ROLE_MAP: "not-json",
    });
    expect(() => createAuthProviders(env, mockPool() as never)).toThrow(/valid JSON/);
  });

  it("throws in production when OIDC is configured without a role map", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-production-secret-key-12345",
      MODELGOV_PRODUCTION: "true",
      OIDC_ISSUER: "https://login.example.com/",
      OIDC_JWKS_URI: "https://login.example.com/.well-known/jwks.json",
      OIDC_AUDIENCE: "modelgov",
    });
    expect(() => createAuthProviders(env, mockPool() as never)).toThrow(/OIDC_ROLE_MAP/);
  });

  it("allows production OIDC with an explicit role map", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-production-secret-key-12345",
      MODELGOV_PRODUCTION: "true",
      OIDC_ISSUER: "https://login.example.com/",
      OIDC_JWKS_URI: "https://login.example.com/.well-known/jwks.json",
      OIDC_AUDIENCE: "modelgov",
      OIDC_ROLE_MAP: JSON.stringify({ "platform-admins": "owner" }),
    });
    expect(() => createAuthProviders(env, mockPool() as never)).not.toThrow();
  });
});

const MINIMAL_YAML = `
project:
  name: bootstrap-test
  environment: test
budgets:
  global:
    monthly_usd: 100
    hard_stop_at_percent: 100
  by_user_type:
    logged_in: { daily_usd: 1, daily_requests: 10, models: [cheap] }
features:
  support_chat: { model_class: cheap, max_tokens: 100, safety: dev }
model_classes:
  cheap: { primary: openai/gpt-4o-mini }
safety:
  preset: dev
`;

describe("resolvePolicy", () => {
  it("loads file config when POLICY_STORE_ENABLED=false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "modelgov-policy-"));
    const configPath = join(dir, "modelgov.yaml");
    writeFileSync(configPath, MINIMAL_YAML);
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: configPath,
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-test-key-1234567890",
      POLICY_STORE_ENABLED: "false",
    });
    const { config, policyMeta } = await resolvePolicy(env, mockPool() as never);
    expect(config.project.name).toBe("bootstrap-test");
    expect(policyMeta.policyVersion).toBe("file");
    expect(policyMeta.configHash).toMatch(/^[0-9a-f]{64}$/);
  });

  const storeEnabledEnv = () => {
    const dir = mkdtempSync(join(tmpdir(), "modelgov-policy-"));
    const configPath = join(dir, "modelgov.yaml");
    writeFileSync(configPath, MINIMAL_YAML);
    return loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: configPath,
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-test-key-1234567890",
      POLICY_STORE_ENABLED: "true",
    });
  };

  const activeVersionRow = (yamlText: string) => ({
    id: "7",
    created_at: new Date(),
    author: null,
    note: null,
    checksum: "abc",
    active: true,
    activated_at: new Date(),
    status: "approved",
    proposed_by: null,
    reviewed_by: "reviewer",
    reviewed_at: new Date(),
    yaml_text: yamlText,
  });

  it("fails boot on a store READ error rather than silently using the file config", async () => {
    // A DB/connection failure must NOT silently bypass the DB-active policy and
    // strand the gateway on the file config until restart — it must propagate.
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("config_versions")) throw new Error("connection terminated unexpectedly");
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({ query: async () => ({ rows: [], rowCount: 1 }), release: () => {} }),
    };
    await expect(resolvePolicy(storeEnabledEnv(), pool as never)).rejects.toThrow(/connection terminated/);
  });

  it("falls back to the file config on a store PARSE error", async () => {
    // A stored version that won't parse (e.g. newer-schema version reaching an
    // older replica mid-rollout) falls back to the known-good file baseline.
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("config_versions")) {
          return { rows: [activeVersionRow("this is not a valid modelgov config")], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({ query: async () => ({ rows: [], rowCount: 1 }), release: () => {} }),
    };
    const { config, policyMeta } = await resolvePolicy(storeEnabledEnv(), pool as never);
    expect(config.project.name).toBe("bootstrap-test");
    expect(policyMeta.policyVersion).toBe("file-fallback");
  });
});

describe("createPolicyResolver", () => {
  it("returns undefined when MULTI_TENANT_POLICY is off", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-test-key-1234567890",
    });
    expect(createPolicyResolver(env, mockPool() as never, { config, policyMeta: {} })).toBeUndefined();
  });

  it("warns and returns undefined when multi-tenant is on without policy store", () => {
    const warn = vi.fn();
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-test-key-1234567890",
      MULTI_TENANT_POLICY: "true",
      POLICY_STORE_ENABLED: "false",
    });
    expect(
      createPolicyResolver(env, mockPool() as never, { config, policyMeta: {} }, { warn }),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      {},
      expect.stringContaining("POLICY_STORE_ENABLED=true"),
    );
  });

  const storeEnv = (extra: Record<string, string>) =>
    loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-test-key-1234567890",
      POLICY_STORE_ENABLED: "true",
      ...extra,
    });

  it("returns a resolver for single-tenant hot reload when the store is on (default)", () => {
    expect(
      createPolicyResolver(storeEnv({}), mockPool() as never, { config, policyMeta: {} }),
    ).toBeDefined();
  });

  it("warns that single-tenant hot reload resolves the default tenant only", () => {
    const warn = vi.fn();
    createPolicyResolver(storeEnv({}), mockPool() as never, { config, policyMeta: {} }, { warn });
    expect(warn).toHaveBeenCalledWith({}, expect.stringContaining("default tenant"));
  });

  it("returns undefined for single-tenant when hot reload is explicitly off", () => {
    expect(
      createPolicyResolver(storeEnv({ POLICY_HOT_RELOAD: "false" }), mockPool() as never, {
        config,
        policyMeta: {},
      }),
    ).toBeUndefined();
  });

  it("returns a resolver for multi-tenant policy when the store is on", () => {
    expect(
      createPolicyResolver(storeEnv({ MULTI_TENANT_POLICY: "true", POLICY_HOT_RELOAD: "false" }), mockPool() as never, {
        config,
        policyMeta: {},
      }),
    ).toBeDefined();
  });
});

describe("startPolicyListener", () => {
  const env = () =>
    loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-test-key-1234567890",
    });
  const log = { info: vi.fn(), warn: vi.fn() };

  it("returns undefined when there is no resolver to invalidate (boot-config path)", () => {
    expect(startPolicyListener(env(), undefined, log)).toBeUndefined();
  });

  it("starts a listener when a resolver is present, and stop() is clean", async () => {
    const resolver = { resolve: vi.fn(), invalidate: vi.fn(), clear: vi.fn() };
    const listener = startPolicyListener(env(), resolver as never, log);
    expect(listener).toBeDefined();
    // No real DB here — the background connect fails and is torn down cleanly.
    await listener?.stop();
  });
});

describe("startBackgroundJobs", () => {
  it("returns undefined when maintenance is disabled", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-test-key-1234567890",
      MAINTENANCE_ENABLED: "false",
    });
    expect(startBackgroundJobs(env, config, mockPool() as never, { warn: vi.fn() } as never)).toBeUndefined();
  });

  it("warns when RESERVATION_STALE_MS is too close to provider timeout", () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost/db",
      MODELGOV_CONFIG: "./modelgov.yaml",
      LITELLM_BASE_URL: "http://localhost:4000",
      MODELGOV_API_KEY: "sk-test-key-1234567890",
      RESERVATION_STALE_MS: "60000",
      LITELLM_TIMEOUT_MS: "60000",
    });
    const timer = startBackgroundJobs(env, config, mockPool() as never, { warn } as never);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reservationStaleMs: 60000 }),
      expect.stringContaining("RESERVATION_STALE_MS"),
    );
    if (timer) clearInterval(timer);
    vi.useRealTimers();
  });
});

describe("warnMissingSafetyBackends", () => {
  it("warns when PII is enabled but Presidio is not configured", () => {
    const strict = parseConfigObject({
      ...{
        project: { name: "test", environment: "test" },
        budgets: {
          global: { monthly_usd: 100, hard_stop_at_percent: 100 },
          by_user_type: { logged_in: { daily_usd: 1, daily_requests: 10, models: ["cheap"] } },
        },
        model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
      },
      features: { support_chat: { safety: "strict", model_class: "cheap", max_tokens: 100 } },
      safety: { preset: "strict", protect: { pii: "block", prompt_injection: "block" } },
    });
    const warn = vi.fn();
    warnMissingSafetyBackends(strict, { warn } as never, { hasPresidio: false, hasInjection: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("PII protection"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("prompt-injection"));
  });
});

describe("createRuntimeServices with safety backends", () => {
  it("wires Presidio when URLs are configured", () => {
    const services = createRuntimeServices(
      {
        LITELLM_BASE_URL: "http://localhost:4000",
        PRESIDIO_ANALYZER_URL: "http://analyzer:3000",
        PRESIDIO_ANONYMIZER_URL: "http://anonymizer:3000",
      } as never,
      config,
    );
    expect(services.hasPresidio).toBe(true);
  });
});
