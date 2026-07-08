import { describe, expect, it } from "vitest";
import { modeConfig, parseOpsFlags, securityConfigWarnings, assertProductionDeploy } from "../src/ops.js";

describe("securityConfigWarnings", () => {
  it("warns on dev API keys and OIDC without audience", () => {
    const lines = securityConfigWarnings({
      MODELGOV_API_KEY: "sk-modelgov-api-local",
      OIDC_ISSUER: "https://login.example.com/",
      OIDC_JWKS_URI: "https://login.example.com/.well-known/jwks.json",
      RATE_LIMIT_FAIL_OPEN: "true",
    });
    expect(lines.some((l) => l.includes("dev default"))).toBe(true);
    expect(lines.some((l) => l.includes("OIDC_AUDIENCE"))).toBe(true);
    expect(lines.some((l) => l.includes("RATE_LIMIT_FAIL_OPEN"))).toBe(true);
  });

  it("flags inferred multitenant without policy store and RLS", () => {
    const lines = securityConfigWarnings({
      MULTI_TENANT_POLICY: "true",
    });
    expect(lines.some((l) => l.includes("POLICY_STORE_ENABLED"))).toBe(true);
    expect(lines.some((l) => l.includes("DB_RLS_ENABLED"))).toBe(true);
  });

  it("fails production misconfigurations", () => {
    const lines = securityConfigWarnings({
      MODELGOV_PRODUCTION: "true",
      MODELGOV_API_KEY: "sk-modelgov-api-local",
      DATABASE_SSL: "disable",
      METRICS_ENABLED: "true",
    });
    expect(lines.some((l) => l.startsWith("fail"))).toBe(true);
  });

  it("assertProductionDeploy throws on fail lines", () => {
    expect(() =>
      assertProductionDeploy({
        MODELGOV_PRODUCTION: "true",
        MODELGOV_API_KEY: "sk-modelgov-api-local",
        DATABASE_SSL: "require",
        METRICS_ENABLED: "true",
        METRICS_AUTH_TOKEN: "secret",
      }),
    ).toThrow(/production deploy checks failed/);
    expect(() =>
      assertProductionDeploy({
        MODELGOV_PRODUCTION: "true",
        MODELGOV_API_KEY: "sk-production-secret-key-12345",
        DATABASE_SSL: "require",
        METRICS_ENABLED: "true",
        METRICS_AUTH_TOKEN: "secret",
      }),
    ).not.toThrow();
  });
});

describe("parseOpsFlags", () => {
  it("defaults to simple mode", () => {
    expect(parseOpsFlags([])).toEqual({ mode: "simple", yes: false, follow: true, strict: false });
  });

  it("parses mode and yes flags", () => {
    expect(parseOpsFlags(["full", "--yes", "--no-follow"])).toEqual({
      mode: "full",
      yes: true,
      follow: false,
      strict: false,
    });
  });

  it("parses cloud mode", () => {
    expect(parseOpsFlags(["cloud"]).mode).toBe("cloud");
  });

  it("parses azure mode", () => {
    expect(parseOpsFlags(["azure"]).mode).toBe("azure");
  });

  it("parses --strict", () => {
    expect(parseOpsFlags(["prod", "--strict"]).strict).toBe(true);
  });

  it("rejects unknown arguments", () => {
    expect(() => parseOpsFlags(["--bogus"])).toThrow(/Unknown ops argument/);
  });
});

describe("modeConfig", () => {
  it("maps simple mode to the default compose file", () => {
    expect(modeConfig("simple").composeArgs).toEqual(["-f", "docker-compose.simple.yml"]);
    expect(modeConfig("simple").apiPort).toBeGreaterThan(0);
  });

  it("honors MODELGOV_PUBLIC_PORT for local API modes", () => {
    const prev = process.env.MODELGOV_PUBLIC_PORT;
    process.env.MODELGOV_PUBLIC_PORT = "3199";
    try {
      expect(modeConfig("simple").apiPort).toBe(3199);
      expect(modeConfig("cloud").apiPort).toBe(3199);
    } finally {
      if (prev === undefined) {
        delete process.env.MODELGOV_PUBLIC_PORT;
      } else {
        process.env.MODELGOV_PUBLIC_PORT = prev;
      }
    }
  });

  it("maps full mode to simple + dev overlay", () => {
    expect(modeConfig("full").composeArgs).toEqual([
      "-f",
      "docker-compose.simple.yml",
      "-f",
      "docker-compose.dev.full.yml",
    ]);
  });

  it("maps local mode to the Ollama overlay on port 3080", () => {
    expect(modeConfig("local").apiPort).toBe(3080);
    expect(modeConfig("local").composeArgs).toContain("docker-compose.local.yml");
  });

  it("maps cloud mode to the cloud-provider overlay", () => {
    expect(modeConfig("cloud").composeArgs).toEqual([
      "-f",
      "docker-compose.simple.yml",
      "-f",
      "docker-compose.cloud.yml",
    ]);
  });

  it("maps azure mode to the Azure OpenAI overlay", () => {
    expect(modeConfig("azure").composeArgs).toEqual([
      "-f",
      "docker-compose.simple.yml",
      "-f",
      "docker-compose.azure.yml",
    ]);
  });

  it("maps prod mode to the production compose file", () => {
    expect(modeConfig("prod").composeArgs).toEqual(["-f", "docker-compose.production.yml"]);
    expect(modeConfig("prod").envFile).toBe(".env.production");
  });
});
