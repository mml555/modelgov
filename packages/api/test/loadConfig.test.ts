import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  loadConfigFromFile,
  resolveEnvRefs,
  warnUnpricedModels,
} from "../src/config/loadConfig";
import { parseConfigObject } from "@ai-guard/policy-engine";

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
});

describe("loadConfigFromFile", () => {
  it("loads YAML from disk and resolves env refs", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiguard-loadcfg-"));
    const path = join(dir, "ai-guard.yaml");
    writeFileSync(path, MINIMAL_YAML);
    const config = loadConfigFromFile(path, { OPENAI_API_KEY: "sk-from-env" });
    expect(config.project.name).toBe("load-test");
    expect(config.providers.openai?.apiKey).toBe("sk-from-env");
  });

  it("passes strictPricing to the parser", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiguard-loadcfg-"));
    const path = join(dir, "ai-guard.yaml");
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
