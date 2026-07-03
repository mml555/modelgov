import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env";

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
