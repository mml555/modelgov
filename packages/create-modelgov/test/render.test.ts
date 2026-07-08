import { parseConfig } from "@modelgov/policy-engine";
import { describe, expect, it } from "vitest";
import { composeFileFor, renderModelgovYaml, renderEnv, type ScaffoldOptions } from "../src/render";
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

describe("renderModelgovYaml (support_chat)", () => {
  it("produces config that parses against the real schema", () => {
    const cfg = parseConfig(renderModelgovYaml(base));
    expect(cfg.project.name).toBe("my-app");
    expect(cfg.features.support_chat?.modelClass).toBe("cheap");
    expect(cfg.modelClasses.cheap?.primary).toBe("openai/gpt-4o-mini");
    expect(cfg.modelClasses.cheap?.fallback).toBe("anthropic/claude-haiku");
    expect(cfg.observability.provider).toBe("none");
  });

  it("sets langfuse observability in full mode", () => {
    expect(parseConfig(renderModelgovYaml({ ...base, mode: "full" })).observability.provider).toBe("langfuse");
  });

  it("omits fallback for a single provider", () => {
    const cfg = parseConfig(renderModelgovYaml({ ...base, providers: ["openai"] }));
    expect(cfg.modelClasses.cheap?.fallback).toBeUndefined();
  });
});

describe("every template renders a valid config", () => {
  for (const id of TEMPLATE_IDS) {
    it(`${id} parses against the real schema`, () => {
      const template = TEMPLATES[id];
      const cfg = parseConfig(renderModelgovYaml({ ...base, template, providers: ["openai", "anthropic"] }));
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
    const cfg = parseConfig(renderModelgovYaml({ ...base, template: TEMPLATES.local_dev, providers: [] }));
    expect(cfg.safety.preset).toBe("dev");
    expect(cfg.modelClasses.local?.primary).toContain("ollama/");
  });

  it("saas_tiers gives free cheap-only and enterprise premium access", () => {
    const cfg = parseConfig(renderModelgovYaml({ ...base, template: TEMPLATES.saas_tiers }));
    expect(cfg.budgets.byUserType.free?.models).toEqual(["cheap"]);
    expect(cfg.budgets.byUserType.enterprise?.models).toContain("premium");
  });
});

describe("renderEnv", () => {
  it("has provider key lines + Presidio for non-dev", () => {
    const env = renderEnv(base);
    expect(env).toContain("OPENAI_API_KEY=");
    expect(env).toContain("MODELGOV_API_KEY=sk-modelgov-api-local");
    expect(env).toContain("MODELGOV_API_IMAGE=ghcr.io/mml555/modelgov/modelgov-api:latest");
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
    expect(adapterFor("nextjs", TEMPLATES.support_chat).installHint).toContain("@modelgov/sdk");
    expect(adapterFor("fastapi", TEMPLATES.support_chat).installHint).toContain("modelgov");
  });

  it("none generates no framework files", () => {
    expect(Object.keys(adapterFor("none", TEMPLATES.support_chat).files)).toHaveLength(0);
  });
});

describe("buildScaffold", () => {
  const opts: ProjectOptions = { ...base, framework: "nextjs" };

  it("produces a complete, runnable file set", () => {
    const files = buildScaffold(opts);
    for (const p of ["modelgov.yaml", ".env", "docker-compose.yml", "litellm_config.yaml", "scripts/smoke.mjs", "README.md", "lib/modelgov.ts", "app/api/ai/route.ts"]) {
      expect(files.has(p), p).toBe(true);
    }
  });

  it("the generated modelgov.yaml validates", () => {
    expect(() => parseConfig(buildScaffold(opts).get("modelgov.yaml")!)).not.toThrow();
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

  it("docker-compose uses MODELGOV_API_IMAGE with a sensible default", () => {
    const compose = buildScaffold(opts).get("docker-compose.yml")!;
    expect(compose).toContain("${MODELGOV_API_IMAGE:-ghcr.io/mml555/modelgov/modelgov-api:latest}");
  });
});

describe("providers (openrouter / azure / azure_ai)", () => {
  it("OpenRouter: valid config, openrouter model strings, and custom pricing emitted", () => {
    const yaml = renderModelgovYaml({ ...base, providers: ["openrouter"] });
    const cfg = parseConfig(yaml);
    expect(cfg.modelClasses.cheap?.primary).toBe("openrouter/openai/gpt-4o-mini");
    // OpenRouter models aren't in the built-in table → pricing must be emitted.
    expect(cfg.pricing?.["openrouter/openai/gpt-4o-mini"]).toBeDefined();
  });

  it("Azure: valid config + generated LiteLLM uses azure api_base/api_version, and .env has them", () => {
    const opts: ProjectOptions = { ...base, providers: ["azure"], framework: "none" };
    const files = buildScaffold(opts);
    const cfg = parseConfig(files.get("modelgov.yaml")!);
    expect(() => parseConfig(files.get("modelgov.yaml")!)).not.toThrow();
    expect(cfg.modelClasses.cheap?.primary).toBe("azure/gpt-4o-mini");
    // Standard Azure deployment names are in the built-in price table — no custom pricing needed.
    expect(cfg.pricing?.["azure/gpt-4o-mini"]).toBeUndefined();
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

  it("Bedrock: valid config, AWS creds in LiteLLM + .env, built-in pricing (no custom)", () => {
    const files = buildScaffold({ ...base, providers: ["bedrock"], framework: "none" });
    const cfg = parseConfig(files.get("modelgov.yaml")!);
    expect(cfg.modelClasses.cheap?.primary).toBe("bedrock/anthropic.claude-3-5-haiku-20241022-v1:0");
    // Bedrock models are in the built-in price table now → no custom pricing.
    expect(cfg.pricing).toBeUndefined();
    // Non-api_key provider: declares auth, no api_key.
    expect(cfg.providers.bedrock?.auth).toBe("aws");
    expect(cfg.providers.bedrock?.apiKey).toBeUndefined();
    const litellm = files.get("litellm_config.yaml")!;
    expect(litellm).toContain("aws_access_key_id: os.environ/AWS_ACCESS_KEY_ID");
    expect(litellm).toContain("aws_region_name: os.environ/AWS_REGION_NAME");
    const env = files.get(".env")!;
    expect(env).toContain("AWS_ACCESS_KEY_ID=");
    expect(env).toContain("AWS_REGION_NAME=us-east-1");
  });

  it("Vertex: valid config, vertex_project/location in LiteLLM, creds in .env", () => {
    const files = buildScaffold({ ...base, providers: ["vertex_ai"], framework: "none" });
    const cfg = parseConfig(files.get("modelgov.yaml")!);
    expect(cfg.modelClasses.cheap?.primary).toBe("vertex_ai/gemini-1.5-flash");
    expect(cfg.providers.vertex_ai?.auth).toBe("gcp");
    const litellm = files.get("litellm_config.yaml")!;
    expect(litellm).toContain("vertex_project: os.environ/VERTEX_PROJECT");
    expect(litellm).toContain("vertex_location: os.environ/VERTEX_LOCATION");
    expect(files.get(".env")!).toContain("GOOGLE_APPLICATION_CREDENTIALS=");
  });

  it("GitHub Copilot: subscription provider, no api_key/pricing, model-only LiteLLM entry", () => {
    const files = buildScaffold({ ...base, providers: ["github_copilot"], framework: "none" });
    const cfg = parseConfig(files.get("modelgov.yaml")!);
    expect(cfg.modelClasses.cheap?.primary).toBe("github_copilot/gpt-4o-mini");
    // Subscription-billed: no per-token pricing emitted, declared billing.
    expect(cfg.pricing).toBeUndefined();
    expect(cfg.providers.github_copilot?.billing).toBe("subscription");
    expect(cfg.providers.github_copilot?.auth).toBe("oauth_device");
    const litellm = files.get("litellm_config.yaml")!;
    expect(litellm).toContain("model: github_copilot/gpt-4o-mini");
    // No api_key line for the copilot model (OAuth device flow, LiteLLM-owned).
    const copilotBlock = litellm.slice(litellm.indexOf("github_copilot/gpt-4o-mini"));
    expect(copilotBlock.slice(0, 120)).not.toContain("api_key");
    expect(files.get(".env")!).toContain("GITHUB_COPILOT_TOKEN=");
  });

  it("Mistral (plain api_key): registry-driven key env in LiteLLM + .env", () => {
    const files = buildScaffold({ ...base, providers: ["mistral"], framework: "none" });
    const cfg = parseConfig(files.get("modelgov.yaml")!);
    expect(cfg.modelClasses.cheap?.primary).toBe("mistral/mistral-small-latest");
    expect(cfg.providers.mistral?.apiKey).toBe("env/MISTRAL_API_KEY");
    expect(files.get("litellm_config.yaml")!).toContain("api_key: os.environ/MISTRAL_API_KEY");
    expect(files.get(".env")!).toContain("MISTRAL_API_KEY=");
  });

  it("Azure AI Foundry: valid config + LiteLLM uses azure_ai api_base, and .env has them", () => {
    const opts: ProjectOptions = {
      ...base,
      providers: ["azure_ai"],
      framework: "none",
      template: TEMPLATES.saas_tiers,
    };
    const files = buildScaffold(opts);
    const cfg = parseConfig(files.get("modelgov.yaml")!);
    expect(cfg.modelClasses.cheap?.primary).toBe("azure_ai/gpt-4o-mini");
    expect(cfg.modelClasses.premium?.primary).toBe("azure_ai/claude-opus-4-1");
    expect(cfg.providers.azure_ai?.apiKey).toBe("env/AZURE_AI_API_KEY");
    expect(cfg.pricing?.["azure_ai/gpt-4o-mini"]).toBeUndefined();
    const litellm = files.get("litellm_config.yaml")!;
    expect(litellm).toContain("model: azure_ai/gpt-4o-mini");
    expect(litellm).toContain("api_key: os.environ/AZURE_AI_API_KEY");
    expect(litellm).toContain("api_base: os.environ/AZURE_AI_API_BASE");
    expect(litellm).not.toContain("api_version:");
    const env = files.get(".env")!;
    expect(env).toContain("AZURE_AI_API_KEY=");
    expect(env).toContain("AZURE_AI_API_BASE=");
  });
});

describe("composeFileFor", () => {
  it("maps modes", () => {
    expect(composeFileFor("simple")).toBe("-f docker-compose.simple.yml");
    expect(composeFileFor("full")).toContain("docker-compose.dev.full.yml");
  });
});
