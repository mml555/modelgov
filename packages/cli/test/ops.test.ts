import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertLitellmConfigUsable,
  ensureGeneratedLitellmConfig,
  hasAnyProviderCredentials,
  modeConfig,
  parseOpsFlags,
  securityConfigWarnings,
  assertProductionDeploy,
  smokePayloadFromPolicyYaml,
} from "../src/ops.js";
import { browserOpenCommand, buildAutoconnectConsoleUrl } from "../src/browserOpen.js";

describe("smokePayloadFromPolicyYaml", () => {
  it("uses support_chat when present", () => {
    const yaml = `
features:
  support_chat:
    model_class: cheap
budgets:
  by_user_type:
    logged_in:
      models: [cheap]
`;
    expect(smokePayloadFromPolicyYaml(yaml)).toEqual({
      feature: "support_chat",
      userType: "logged_in",
      modelClass: "cheap",
    });
  });

  it("falls back to the first configured feature", () => {
    const yaml = `
features:
  assistant:
    model_class: cheap
budgets:
  by_user_type:
    pro:
      models: [cheap, standard]
`;
    expect(smokePayloadFromPolicyYaml(yaml)).toEqual({
      feature: "assistant",
      userType: "pro",
      modelClass: "cheap",
    });
  });
});

describe("hasAnyProviderCredentials", () => {
  it("accepts Gemini and other non-OpenAI keys", () => {
    expect(hasAnyProviderCredentials({ GEMINI_API_KEY: "AIza-real-key-value" })).toBe(true);
    expect(hasAnyProviderCredentials({ OPENAI_API_KEY: "sk-..." })).toBe(false);
    expect(hasAnyProviderCredentials({})).toBe(false);
  });
});

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
    expect(parseOpsFlags([])).toEqual({ mode: "simple", yes: false, follow: true, strict: false, json: false });
  });

  it("parses mode and yes flags", () => {
    expect(parseOpsFlags(["full", "--yes", "--no-follow"])).toEqual({
      mode: "full",
      yes: true,
      follow: false,
      strict: false,
      json: false,
    });
  });

  it("parses --json", () => {
    expect(parseOpsFlags(["--json"]).json).toBe(true);
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

describe("buildAutoconnectConsoleUrl", () => {
  it("builds a console URL with encoded url and token query params", () => {
    const url = buildAutoconnectConsoleUrl("http://localhost:3090", "sk-modelgov-api-local");
    expect(url).toBe(
      "http://localhost:5174/login?url=http%3A%2F%2Flocalhost%3A3090&token=sk-modelgov-api-local",
    );
  });
});

describe("browserOpenCommand", () => {
  const url = "http://localhost:5174/login?url=x&token=y";
  it("uses open on macOS", () => {
    expect(browserOpenCommand("darwin", url)).toEqual({ cmd: "open", args: [url] });
  });
  it("uses xdg-open on Linux", () => {
    expect(browserOpenCommand("linux", url)).toEqual({ cmd: "xdg-open", args: [url] });
  });
  it("uses cmd /c start with an empty title arg on Windows", () => {
    expect(browserOpenCommand("win32", url)).toEqual({ cmd: "cmd", args: ["/c", "start", "", url] });
  });
});

describe("ensureGeneratedLitellmConfig", () => {
  const dirs: string[] = [];
  const root = () => {
    const d = mkdtempSync(join(tmpdir(), "modelgov-seed-"));
    dirs.push(d);
    writeFileSync(join(d, "litellm_config.yaml"), "# demo\nmodel_list: []\n");
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("seeds the generated config from the demo config when absent", () => {
    const r = root();
    ensureGeneratedLitellmConfig(r);
    expect(readFileSync(join(r, "litellm_config.generated.yaml"), "utf8")).toContain("# demo");
  });

  it("keeps an existing real generated config (wizard-written) untouched", () => {
    const r = root();
    writeFileSync(join(r, "litellm_config.generated.yaml"), "# gemini\nmodel_list: [x]\n");
    ensureGeneratedLitellmConfig(r);
    expect(readFileSync(join(r, "litellm_config.generated.yaml"), "utf8")).toContain("# gemini");
  });

  it("auto-heals an EMPTY directory left by Docker into a seeded file", () => {
    const r = root();
    mkdirSync(join(r, "litellm_config.generated.yaml")); // the Docker land-mine
    ensureGeneratedLitellmConfig(r);
    // Now a real file with demo content (guard would otherwise crash the proxy).
    expect(readFileSync(join(r, "litellm_config.generated.yaml"), "utf8")).toContain("# demo");
  });

  it("leaves a NON-empty directory for the guard to surface", () => {
    const r = root();
    mkdirSync(join(r, "litellm_config.generated.yaml"));
    writeFileSync(join(r, "litellm_config.generated.yaml", "keep.txt"), "x");
    ensureGeneratedLitellmConfig(r);
    expect(() => assertLitellmConfigUsable(r)).toThrow(/is a directory/);
  });
});

describe("assertLitellmConfigUsable", () => {
  const dirs: string[] = [];
  const root = () => {
    const d = mkdtempSync(join(tmpdir(), "modelgov-guard-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("passes when the default generated config exists", () => {
    const r = root();
    writeFileSync(join(r, "litellm_config.generated.yaml"), "model_list: []\n");
    expect(() => assertLitellmConfigUsable(r)).not.toThrow();
  });

  it("throws when a configured LITELLM_CONFIG_PATH points at a missing file", () => {
    const r = root();
    writeFileSync(join(r, ".env"), "LITELLM_CONFIG_PATH=./litellm_config.generated.yaml\n");
    expect(() => assertLitellmConfigUsable(r)).toThrow(/does not exist/);
  });

  it("throws when the config path is a directory (the IsADirectoryError land-mine)", () => {
    const r = root();
    mkdirSync(join(r, "litellm_config.generated.yaml"));
    expect(() => assertLitellmConfigUsable(r)).toThrow(/is a directory/);
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
