import { parseConfig } from "@ai-guard/policy-engine";
import { describe, expect, it } from "vitest";
import { composeFileFor, renderAiGuardYaml, renderEnv, type ScaffoldOptions } from "../src/render";
import { TEMPLATES, TEMPLATE_IDS } from "../src/templates";
import { adapterFor, type Framework } from "../src/adapters";
import { buildScaffold, type ProjectOptions } from "../src/scaffold";

const base: ScaffoldOptions = {
  projectName: "my-app",
  providers: ["openai", "anthropic"],
  mode: "simple",
  safetyPreset: "balanced",
  template: TEMPLATES.support_chat,
};

describe("renderAiGuardYaml (support_chat)", () => {
  it("produces config that parses against the real schema", () => {
    const cfg = parseConfig(renderAiGuardYaml(base));
    expect(cfg.project.name).toBe("my-app");
    expect(cfg.features.support_chat?.modelClass).toBe("cheap");
    expect(cfg.modelClasses.cheap?.primary).toBe("openai/gpt-4o-mini");
    expect(cfg.modelClasses.cheap?.fallback).toBe("anthropic/claude-haiku");
    expect(cfg.observability.provider).toBe("none");
  });

  it("sets langfuse observability in full mode", () => {
    expect(parseConfig(renderAiGuardYaml({ ...base, mode: "full" })).observability.provider).toBe("langfuse");
  });

  it("omits fallback for a single provider", () => {
    const cfg = parseConfig(renderAiGuardYaml({ ...base, providers: ["openai"] }));
    expect(cfg.modelClasses.cheap?.fallback).toBeUndefined();
  });
});

describe("every template renders a valid config", () => {
  for (const id of TEMPLATE_IDS) {
    it(`${id} parses against the real schema`, () => {
      const template = TEMPLATES[id];
      const cfg = parseConfig(renderAiGuardYaml({ ...base, template, providers: ["openai", "anthropic"] }));
      // The primary feature exists and its model class is defined.
      const feat = cfg.features[template.primaryFeature];
      expect(feat, `feature ${template.primaryFeature}`).toBeDefined();
      expect(cfg.modelClasses[feat!.modelClass], `class ${feat!.modelClass}`).toBeDefined();
      // The example user type exists and permits the feature's class.
      const ut = cfg.budgets.byUserType[template.exampleUserType];
      expect(ut, `userType ${template.exampleUserType}`).toBeDefined();
    });
  }

  it("local_dev needs no cloud provider and uses dev safety", () => {
    const cfg = parseConfig(renderAiGuardYaml({ ...base, template: TEMPLATES.local_dev, providers: [] }));
    expect(cfg.safety.preset).toBe("dev");
    expect(cfg.modelClasses.local?.primary).toContain("ollama/");
  });

  it("saas_tiers gives free cheap-only and enterprise premium access", () => {
    const cfg = parseConfig(renderAiGuardYaml({ ...base, template: TEMPLATES.saas_tiers }));
    expect(cfg.budgets.byUserType.free?.models).toEqual(["cheap"]);
    expect(cfg.budgets.byUserType.enterprise?.models).toContain("premium");
  });
});

describe("renderEnv", () => {
  it("has provider key lines + Presidio for non-dev", () => {
    const env = renderEnv(base);
    expect(env).toContain("OPENAI_API_KEY=");
    expect(env).toContain("AI_GUARD_API_KEY=sk-ai-guard-api-local");
    expect(env).toContain("AI_GUARD_API_IMAGE=ghcr.io/ai-guard/ai-guard-api:latest");
    expect(env).toContain("PRESIDIO_ANALYZER_URL=");
  });
  it("omits provider keys for the local template", () => {
    const env = renderEnv({ ...base, template: TEMPLATES.local_dev, providers: [] });
    expect(env).not.toContain("OPENAI_API_KEY=");
    expect(env).not.toContain("PRESIDIO_ANALYZER_URL=");
  });
});

describe("framework adapters", () => {
  const frameworks: Framework[] = ["nextjs", "express", "fastify", "fastapi"];
  for (const fw of frameworks) {
    it(`${fw} generates a route referencing the template's feature`, () => {
      const out = adapterFor(fw, TEMPLATES.support_chat);
      const routeFile = Object.entries(out.files).find(([p]) => /route|ai\.(ts|py)/.test(p));
      expect(routeFile).toBeDefined();
      const needle = fw === "fastapi" ? 'feature="support_chat"' : 'feature: "support_chat"';
      expect(routeFile![1]).toContain(needle);
    });
  }

  it("nextjs uses the TS SDK; fastapi uses the Python SDK", () => {
    expect(adapterFor("nextjs", TEMPLATES.support_chat).installHint).toContain("@ai-guard/sdk");
    expect(adapterFor("fastapi", TEMPLATES.support_chat).installHint).toContain("ai-guard-sdk");
  });

  it("none generates no framework files", () => {
    expect(Object.keys(adapterFor("none", TEMPLATES.support_chat).files)).toHaveLength(0);
  });
});

describe("buildScaffold", () => {
  const opts: ProjectOptions = { ...base, framework: "nextjs" };

  it("produces a complete, runnable file set", () => {
    const files = buildScaffold(opts);
    for (const p of ["ai-guard.yaml", ".env", "docker-compose.yml", "litellm_config.yaml", "scripts/smoke.mjs", "README.md", "lib/ai-guard.ts", "app/api/ai/route.ts"]) {
      expect(files.has(p), p).toBe(true);
    }
  });

  it("the generated ai-guard.yaml validates", () => {
    expect(() => parseConfig(buildScaffold(opts).get("ai-guard.yaml")!)).not.toThrow();
  });

  it("litellm_config lists the models the template uses", () => {
    const litellm = buildScaffold(opts).get("litellm_config.yaml")!;
    expect(litellm).toContain("model_name: openai/gpt-4o-mini");
    expect(litellm).toContain("os.environ/LITELLM_MASTER_KEY");
  });

  it("smoke script targets the primary feature", () => {
    expect(buildScaffold(opts).get("scripts/smoke.mjs")!).toContain('feature: "support_chat"');
  });

  it("local template compose omits Presidio and its config needs no key", () => {
    const files = buildScaffold({ ...opts, template: TEMPLATES.local_dev, providers: [] });
    expect(files.get("docker-compose.yml")!).not.toContain("presidio-analyzer");
    expect(files.get("litellm_config.yaml")!).toContain("ollama/llama3.2:3b");
  });

  it("docker-compose uses AI_GUARD_API_IMAGE with a sensible default", () => {
    const compose = buildScaffold(opts).get("docker-compose.yml")!;
    expect(compose).toContain("${AI_GUARD_API_IMAGE:-ghcr.io/ai-guard/ai-guard-api:latest}");
  });
});

describe("providers (openrouter / azure)", () => {
  it("OpenRouter: valid config, openrouter model strings, and custom pricing emitted", () => {
    const yaml = renderAiGuardYaml({ ...base, providers: ["openrouter"] });
    const cfg = parseConfig(yaml);
    expect(cfg.modelClasses.cheap?.primary).toBe("openrouter/openai/gpt-4o-mini");
    // OpenRouter models aren't in the built-in table → pricing must be emitted.
    expect(cfg.pricing?.["openrouter/openai/gpt-4o-mini"]).toBeDefined();
  });

  it("Azure: valid config + generated LiteLLM uses azure api_base/api_version, and .env has them", () => {
    const opts: ProjectOptions = { ...base, providers: ["azure"], framework: "none" };
    const files = buildScaffold(opts);
    expect(() => parseConfig(files.get("ai-guard.yaml")!)).not.toThrow();
    const litellm = files.get("litellm_config.yaml")!;
    expect(litellm).toContain("model: azure/gpt-4o-mini");
    expect(litellm).toContain("api_key: os.environ/AZURE_API_KEY");
    expect(litellm).toContain("api_base: os.environ/AZURE_API_BASE");
    expect(litellm).toContain("api_version: os.environ/AZURE_API_VERSION");
    expect(files.get(".env")!).toContain("AZURE_API_BASE=");
  });

  it("OpenRouter LiteLLM entry uses the OpenRouter key", () => {
    const litellm = buildScaffold({ ...base, providers: ["openrouter"], framework: "none" }).get("litellm_config.yaml")!;
    expect(litellm).toContain("model: openrouter/openai/gpt-4o-mini");
    expect(litellm).toContain("api_key: os.environ/OPENROUTER_API_KEY");
  });
});

describe("composeFileFor", () => {
  it("maps modes", () => {
    expect(composeFileFor("simple")).toBe("-f docker-compose.simple.yml");
    expect(composeFileFor("full")).toContain("docker-compose.dev.full.yml");
  });
});
