import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadDatabaseEnv, loadEnv } from "../src/config/env";

const requiredEnv = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/modelgov",
  MODELGOV_CONFIG: "modelgov.yaml",
  LITELLM_BASE_URL: "http://localhost:4000",
};

describe("loadEnv", () => {
  it("allows scoped API keys without a fallback plaintext API key", () => {
    const secretHash = createHash("sha256").update("secret").digest("hex");
    const env = loadEnv({
      ...requiredEnv,
      MODELGOV_API_KEY: "",
      MODELGOV_API_KEYS: JSON.stringify([
        { name: "tenant-a", keyHash: secretHash, projectId: "tenant-a" },
      ]),
    });

    expect(env.apiKeys).toEqual([
      {
        name: "tenant-a",
        keyHash: secretHash,
        projectId: "tenant-a",
        permissions: ["chat:create"],
      },
    ]);
  });

  it("normalizes empty optional production-compose values", () => {
    const env = loadEnv({
      ...requiredEnv,
      MODELGOV_API_KEY: "secret",
      MODELGOV_API_KEYS: "",
      BUDGET_ALERT_WEBHOOK_URL: "",
      LANGFUSE_HOST: "",
      REDIS_URL: "",
    });

    expect(env.REDIS_URL).toBeUndefined();
    expect(env.BUDGET_ALERT_WEBHOOK_URL).toBeUndefined();
    expect(env.LANGFUSE_HOST).toBeUndefined();
    expect(env.apiKeys[0]?.key).toBe("secret");
  });

  it("grants owner permissions to known local dev keys", () => {
    const env = loadEnv({
      ...requiredEnv,
      MODELGOV_API_KEY: "sk-modelgov-api-local",
    });

    expect(env.apiKeys[0]?.permissions).toContain("usage:read");
    expect(env.apiKeys[0]?.permissions).toContain("keys:admin");
  });

  it("keeps chat:create only for non-dev single keys", () => {
    const env = loadEnv({
      ...requiredEnv,
      MODELGOV_API_KEY: "sk-production-secret-key-12345",
    });

    expect(env.apiKeys[0]?.permissions).toEqual(["chat:create"]);
  });

  it("fails fast when no API credential source is configured", () => {
    expect(() =>
      loadEnv({
        ...requiredEnv,
        MODELGOV_API_KEY: "",
        MODELGOV_API_KEYS: "",
      }),
    ).toThrow(/MODELGOV_API_KEY or MODELGOV_API_KEYS is required/);
  });
});

// The migrate entrypoint runs BEFORE the API process and needs only the DB block,
// so it uses this narrow loader rather than loadEnv — meaning `modelgov migrate`
// must not require MODELGOV_API_KEY / LITELLM_BASE_URL to start. That distinction
// is the whole reason the function exists, so it is pinned here.
describe("loadDatabaseEnv", () => {
  it("loads the DB block without any API or LiteLLM settings present", () => {
    const env = loadDatabaseEnv({ DATABASE_URL: requiredEnv.DATABASE_URL });
    expect(env.DATABASE_URL).toBe(requiredEnv.DATABASE_URL);
  });

  it("rejects a missing DATABASE_URL with a field-named message", () => {
    expect(() => loadDatabaseEnv({})).toThrow(/Invalid environment.*DATABASE_URL/s);
  });

  it("rejects an empty DATABASE_URL", () => {
    expect(() => loadDatabaseEnv({ DATABASE_URL: "" })).toThrow(/DATABASE_URL is required/);
  });

  it("does NOT validate the URL's shape — reachability is assertPoolReachable's job", () => {
    // Deliberate: the schema is `min(1)`, not `.url()`, because node-pg accepts
    // forms a URL parser would reject (e.g. a unix socket path). A bad value fails
    // at connect time with a real pg error, not with a schema message.
    expect(() => loadDatabaseEnv({ DATABASE_URL: "/var/run/postgresql" })).not.toThrow();
  });

  it("carries the TLS mode through", () => {
    const env = loadDatabaseEnv({
      DATABASE_URL: requiredEnv.DATABASE_URL,
      DATABASE_SSL: "verify-full",
      DATABASE_SSL_CA: "/etc/ssl/pg-ca.pem",
    });
    expect(env.DATABASE_SSL).toBe("verify-full");
    expect(env.DATABASE_SSL_CA).toBe("/etc/ssl/pg-ca.pem");
  });

  it("rejects an unknown TLS mode instead of silently disabling TLS", () => {
    expect(() =>
      loadDatabaseEnv({ DATABASE_URL: requiredEnv.DATABASE_URL, DATABASE_SSL: "sorta" }),
    ).toThrow(/Invalid environment.*DATABASE_SSL/s);
  });

  it("treats an empty DATABASE_SSL_CA as absent, not as an empty path", () => {
    // An empty string would otherwise become a readFileSync("") at pool creation.
    const env = loadDatabaseEnv({
      DATABASE_URL: requiredEnv.DATABASE_URL,
      DATABASE_SSL_CA: "",
    });
    expect(env.DATABASE_SSL_CA).toBeUndefined();
  });
});
