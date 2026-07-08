import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadConfigFromFile,
  resolveEnvRefs,
  setPolicyEnvRefAllowlist,
  warnUnpricedModels,
} from "../src/config/loadConfig";
import { parseConfigObject } from "@modelgov/policy-engine";

const MINIMAL_YAML = `
project:
  name: load-test
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
providers:
  openai:
    api_key: env/OPENAI_API_KEY
`;

describe("resolveEnvRefs", () => {
  const minimalRaw = {
    project: { name: "t", environment: "test" },
    budgets: {
      global: { monthly_usd: 1, hard_stop_at_percent: 100 },
      by_user_type: { logged_in: { daily_usd: 1, daily_requests: 1, models: ["cheap"] } },
    },
    features: { f: { model_class: "cheap", max_tokens: 1, safety: "dev" } },
    model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
    safety: { preset: "dev" },
    providers: { openai: { api_key: "env/OPENAI_API_KEY" } },
  };

  it("substitutes env/VAR provider keys from the env map", () => {
    const config = parseConfigObject(minimalRaw);
    const resolved = resolveEnvRefs(config, { OPENAI_API_KEY: "sk-test" });
    expect(resolved.providers.openai?.apiKey).toBe("sk-test");
  });

  it("leaves unresolved refs undefined when the env var is missing", () => {
    const config = parseConfigObject(minimalRaw);
    const resolved = resolveEnvRefs(config, {});
    expect(resolved.providers.openai?.apiKey).toBeUndefined();
  });

  it("invokes onMissing for a referenced-but-unset var", () => {
    const config = parseConfigObject(minimalRaw);
    const onMissing = vi.fn();
    resolveEnvRefs(config, {}, onMissing);
    expect(onMissing).toHaveBeenCalledWith("OPENAI_API_KEY", "openai");
  });
});

describe("resolveEnvRefs allowlist (F3)", () => {
  const withProviderKey = (apiKey: string) =>
    parseConfigObject({
      project: { name: "t", environment: "test" },
      budgets: {
        global: { monthly_usd: 1, hard_stop_at_percent: 100 },
        by_user_type: { logged_in: { daily_usd: 1, daily_requests: 1, models: ["cheap"] } },
      },
      features: { f: { model_class: "cheap", max_tokens: 1, safety: "dev" } },
      model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
      safety: { preset: "dev" },
      providers: { openai: { api_key: apiKey } },
    });

  afterEach(() => setPolicyEnvRefAllowlist([])); // reset the module-level allowlist

  it("resolves a _KEY-suffixed provider var by default", () => {
    const resolved = resolveEnvRefs(withProviderKey("env/MY_OPENAI_KEY"), { MY_OPENAI_KEY: "sk-x" });
    expect(resolved.providers.openai?.apiKey).toBe("sk-x");
  });

  it("refuses a gateway secret even when the env value is present", () => {
    const onMissing = vi.fn();
    const resolved = resolveEnvRefs(
      withProviderKey("env/STRIPE_SECRET_KEY"),
      { STRIPE_SECRET_KEY: "sk_live_should_not_leak" },
      onMissing,
    );
    expect(resolved.providers.openai?.apiKey).toBeUndefined();
    expect(onMissing).toHaveBeenCalledWith("STRIPE_SECRET_KEY", "openai");
  });

  it("refuses a non-allowlisted var (does not end in _KEY)", () => {
    const resolved = resolveEnvRefs(withProviderKey("env/MY_TOKEN"), { MY_TOKEN: "tok" });
    expect(resolved.providers.openai?.apiKey).toBeUndefined();
  });

  it("resolves a non-_KEY var once added to the explicit allowlist", () => {
    setPolicyEnvRefAllowlist(["MY_TOKEN"]);
    const resolved = resolveEnvRefs(withProviderKey("env/MY_TOKEN"), { MY_TOKEN: "tok" });
    expect(resolved.providers.openai?.apiKey).toBe("tok");
  });

  it("resolves known provider credential vars that don't end in _KEY", () => {
    // These are non-_KEY names the registry marks as provider credentials, so
    // they resolve without needing MODELGOV_POLICY_ENV_ALLOWLIST.
    for (const [varName, value] of [
      ["AWS_ACCESS_KEY_ID", "AKIA..."],
      ["AWS_SESSION_TOKEN", "sess..."],
      ["AWS_REGION_NAME", "us-east-1"],
      ["GOOGLE_APPLICATION_CREDENTIALS", "/etc/gcp.json"],
      ["AZURE_API_BASE", "https://x.openai.azure.com"],
      ["AZURE_API_VERSION", "2024-08-01-preview"],
      ["GITHUB_COPILOT_TOKEN", "ghu_..."],
    ] as const) {
      const resolved = resolveEnvRefs(withProviderKey(`env/${varName}`), { [varName]: value });
      expect(resolved.providers.openai?.apiKey).toBe(value);
    }
  });

  it("still refuses an unknown non-_KEY var not in the registry", () => {
    const resolved = resolveEnvRefs(withProviderKey("env/RANDOM_VALUE"), { RANDOM_VALUE: "x" });
    expect(resolved.providers.openai?.apiKey).toBeUndefined();
  });
});

describe("loadConfigFromFile", () => {
  it("loads YAML from disk and resolves env refs", () => {
    const dir = mkdtempSync(join(tmpdir(), "modelgov-loadcfg-"));
    const path = join(dir, "modelgov.yaml");
    writeFileSync(path, MINIMAL_YAML);
    const config = loadConfigFromFile(path, { OPENAI_API_KEY: "sk-from-env" });
    expect(config.project.name).toBe("load-test");
    expect(config.providers.openai?.apiKey).toBe("sk-from-env");
  });

  it("passes strictPricing to the parser", () => {
    const dir = mkdtempSync(join(tmpdir(), "modelgov-loadcfg-"));
    const path = join(dir, "modelgov.yaml");
    writeFileSync(path, MINIMAL_YAML);
    expect(() => loadConfigFromFile(path, {}, { strictPricing: true })).not.toThrow();
  });
});

describe("warnUnpricedModels", () => {
  it("logs when models lack static price entries", () => {
    const config = parseConfigObject({
      project: { name: "t", environment: "test" },
      budgets: {
        global: { monthly_usd: 1, hard_stop_at_percent: 100 },
        by_user_type: { logged_in: { daily_usd: 1, daily_requests: 1, models: ["exotic"] } },
      },
      features: { f: { model_class: "exotic", max_tokens: 1, safety: "dev" } },
      model_classes: { exotic: { primary: "custom/unknown-model" } },
      safety: { preset: "dev" },
    });
    const warn = vi.fn();
    warnUnpricedModels(config, { warn });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ models: expect.arrayContaining(["custom/unknown-model"]) }),
      expect.stringContaining("PRICE_TABLE"),
    );
  });

  it("is silent when all models are priced", () => {
    const config = parseConfigObject({
      project: { name: "t", environment: "test" },
      budgets: {
        global: { monthly_usd: 1, hard_stop_at_percent: 100 },
        by_user_type: { logged_in: { daily_usd: 1, daily_requests: 1, models: ["cheap"] } },
      },
      features: { f: { model_class: "cheap", max_tokens: 1, safety: "dev" } },
      model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
      safety: { preset: "dev" },
    });
    const warn = vi.fn();
    warnUnpricedModels(config, { warn });
    expect(warn).not.toHaveBeenCalled();
  });
});
