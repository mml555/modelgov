import { stringify } from "yaml";
import { PROVIDER_REGISTRY } from "@modelgov/policy-engine";
import { HYBRID_INJECTION_MODEL } from "./litellm";
import type { ModelClass, SafetyPreset, Template } from "./templates";

// The providers the wizard offers. Each MUST be a registry slug that defines
// `defaultModels` for cheap/standard/premium (asserted by tests). Adding a
// provider is: an entry in @modelgov/policy-engine's registry + this list + a
// UI option in index.ts — model strings, prices, env vars, and LiteLLM wiring
// all derive from the registry.
export const WIZARD_PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "azure",
  "azure_ai",
  "bedrock",
  "vertex_ai",
  "mistral",
  "groq",
  "xai",
  "deepseek",
  "cohere",
  "github_copilot",
] as const;
export type Provider = (typeof WIZARD_PROVIDERS)[number];
export type DeployMode = "simple" | "full";
export type { SafetyPreset } from "./templates";

export interface ScaffoldOptions {
  projectName: string;
  providers: Provider[];
  mode: DeployMode;
  safetyPreset: SafetyPreset;
  template: Template;
  /** Override global monthly spend cap (USD). */
  monthlyBudgetUsd?: number;
  /**
   * Local-dev only: route prompt-injection screening through the built-in demo
   * model so each guarded chat uses one real provider call instead of two.
   */
  hybridInjection?: boolean;
}

const OLLAMA = "ollama/llama3.2:3b";
const LOCAL_MODEL = OLLAMA;

/** Primary model string for a class × provider, from the registry's presets. */
function primaryModel(cls: ModelClass, provider: Provider): string {
  if (cls === "local") return LOCAL_MODEL;
  return PROVIDER_REGISTRY[provider]?.defaultModels?.[cls] ?? LOCAL_MODEL;
}

// Prices (USD / 1K tokens) for models NOT in Modelgov's built-in price table, so
// the generated modelgov.yaml can budget them. Providers registered with prices
// (bedrock, vertex_ai, mistral, …) are already in the built-in table and need no
// entry here; OpenRouter is priced per-route, so it does.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "openrouter/openai/gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "openrouter/openai/gpt-4o": { input: 0.0025, output: 0.01 },
  "openrouter/anthropic/claude-3.5-sonnet": { input: 0.003, output: 0.015 },
};

// Placeholder values for credential env vars that benefit from a hint in `.env`.
const ENV_HINTS: Record<string, string> = {
  AZURE_API_BASE: "https://<your-resource>.openai.azure.com",
  AZURE_API_VERSION: "2024-08-01-preview",
  AZURE_AI_API_BASE: "https://<your-resource>.services.ai.azure.com",
  AWS_REGION_NAME: "us-east-1",
  VERTEX_LOCATION: "us-central1",
  GOOGLE_APPLICATION_CREDENTIALS: "/path/to/service-account.json",
};

// Extra `.env` comment lines appended after a provider's credential lines.
const ENV_NOTES: Partial<Record<Provider, string[]>> = {
  azure_ai: [
    "# For Foundry Claude deployments, use e.g. https://<resource>.services.ai.azure.com/anthropic",
  ],
  github_copilot: [
    "# GitHub Copilot uses an OAuth device flow that LiteLLM performs on first use.",
    "# For a headless proxy, pre-provision the token (see docs/providers.md) or set it here.",
  ],
};

/**
 * The modelgov.yaml `providers:` entry for a provider. api_key providers get an
 * `env/VAR` key ref; non-api_key providers (Bedrock/Vertex/Copilot) declare
 * their `auth` (and `billing` for subscription) — credentials themselves live in
 * `.env` and are read by LiteLLM, not modelgov.
 */
function providerConfigEntry(p: Provider): Record<string, string> {
  const spec = PROVIDER_REGISTRY[p];
  switch (spec?.authKind) {
    case "api_key":
      return { api_key: `env/${spec.credentialEnvVars[0]}` };
    case "aws":
      return { auth: "aws" };
    case "gcp":
      return { auth: "gcp" };
    case "oauth_device":
      return spec.billingKind === "subscription"
        ? { auth: "oauth_device", billing: "subscription" }
        : { auth: "oauth_device" };
    default:
      return {};
  }
}

/** Resolve primary + optional fallback (a different provider at the same tier). */
function modelClassEntry(cls: ModelClass, providers: Provider[]): { primary: string; fallback?: string } {
  if (cls === "local") return { primary: LOCAL_MODEL };
  const primary = primaryModel(cls, providers[0]!);
  const alt = providers.find((p) => p !== providers[0]);
  return alt ? { primary, fallback: primaryModel(cls, alt) } : { primary };
}

/** Build a valid modelgov.yaml (snake_case) from wizard answers + template. */
export function renderModelgovYaml(opts: ScaffoldOptions): string {
  const t = opts.template;
  const localOnly = t.localOnly === true;
  const providers = localOnly ? [] : opts.providers;
  const preset: SafetyPreset = localOnly ? "dev" : opts.safetyPreset;
  const useHybridInjection =
    !localOnly && opts.hybridInjection === true && preset !== "dev";
  const injectionModel = localOnly
    ? LOCAL_MODEL
    : useHybridInjection
      ? HYBRID_INJECTION_MODEL
      : primaryModel("cheap", opts.providers[0]!);

  const features = Object.fromEntries(
    Object.entries(t.features).map(([name, f]) => [
      name,
      {
        safety: f.safety ?? preset,
        model_class: f.modelClass,
        max_tokens: f.maxTokens,
        ...(f.budgetMonthlyUsd != null ? { budget: { monthly_usd: f.budgetMonthlyUsd } } : {}),
        ...(f.dataSensitivity ? { data_sensitivity: f.dataSensitivity } : {}),
      },
    ]),
  );

  const byUserType = Object.fromEntries(
    Object.entries(t.userTypes).map(([name, u]) => [
      name,
      { daily_usd: u.dailyUsd, daily_requests: u.dailyRequests, models: u.models },
    ]),
  );

  const modelClasses = Object.fromEntries(
    t.modelClasses.map((cls) => [cls, modelClassEntry(cls, opts.providers)]),
  );

  // Custom pricing for any used model not in Modelgov's built-in table
  // (OpenRouter, custom Azure deployment names, etc.) so budgets estimate correctly.
  const pricing: Record<string, { input_per_1k: number; output_per_1k: number }> = {};
  for (const m of modelStringsFor({ ...opts, providers: opts.providers })) {
    const p = MODEL_PRICING[m];
    if (p) pricing[m] = { input_per_1k: p.input, output_per_1k: p.output };
  }

  const config: Record<string, unknown> = {
    project: { name: opts.projectName, environment: "development" },
    ...(providers.length
      ? {
          providers: Object.fromEntries(
            providers.map((p) => [p, providerConfigEntry(p)]),
          ),
        }
      : {}),
    budgets: {
      global: { monthly_usd: opts.monthlyBudgetUsd ?? 500, alert_at_percent: 80, hard_stop_at_percent: 100 },
      by_user_type: byUserType,
    },
    features,
    routing: {
      degrade_at_percent: 80,
      retry: {
        max_attempts: 3,
        backoff_ms: [500, 2000, 8000],
        retry_on: [429, 502, 503],
        respect_retry_after: true,
      },
    },
    model_classes: modelClasses,
    safety: { preset, injection_model: injectionModel },
    ...(t.dataClasses
      ? {
          data_classes: Object.fromEntries(
            Object.entries(t.dataClasses).map(([k, v]) => [
              k,
              {
                ...(v.allowedModelClasses ? { allowed_model_classes: v.allowedModelClasses } : {}),
                ...(v.allowedProviders ? { allowed_providers: v.allowedProviders } : {}),
              },
            ]),
          ),
        }
      : {}),
    observability: { provider: opts.mode === "full" ? "langfuse" : "none" },
    ...(Object.keys(pricing).length ? { pricing } : {}),
  };

  const header =
    `# Generated by create-modelgov (${t.id} template). Edit freely.\n` +
    "# Provider api_key env/VAR refs are resolved by the Modelgov API at load time.\n\n";
  return header + stringify(config);
}

/** Build a .env with placeholders for the chosen providers + service URLs. */
export function renderEnv(opts: ScaffoldOptions): string {
  const localOnly = opts.template.localOnly === true;
  const lines: string[] = [];
  if (!localOnly) {
    lines.push("# Provider credentials (consumed by the LiteLLM proxy)");
    for (const p of opts.providers) {
      const spec = PROVIDER_REGISTRY[p];
      for (const v of spec?.credentialEnvVars ?? []) {
        lines.push(`${v}=${ENV_HINTS[v] ?? ""}`);
      }
      for (const note of ENV_NOTES[p] ?? []) lines.push(note);
    }
    lines.push("");
  }
  lines.push(
    "# LiteLLM proxy",
    "LITELLM_MASTER_KEY=sk-modelgov-local",
    "",
    "# Modelgov API",
    "# Pin to a digest in production — see https://github.com/mml555/modelgov/pkgs/container/modelgov-api",
    "MODELGOV_API_IMAGE=ghcr.io/mml555/modelgov/modelgov-api:latest",
    "PORT=3000",
    "MODELGOV_API_KEY=sk-modelgov-api-local",
    "DATABASE_URL=postgres://postgres:postgres@postgres:5432/modelgov",
    "LITELLM_BASE_URL=http://litellm:4000",
    "MODELGOV_CONFIG=modelgov.yaml",
  );
  const preset = localOnly ? "dev" : opts.safetyPreset;
  if (preset !== "dev") {
    lines.push(
      "",
      "# Safety (Presidio)",
      "PRESIDIO_ANALYZER_URL=http://presidio-analyzer:3000",
      "PRESIDIO_ANONYMIZER_URL=http://presidio-anonymizer:3000",
    );
  }
  return lines.join("\n") + "\n";
}

/** Concrete model strings (primary + fallback) the template's classes use. */
export function modelStringsFor(opts: ScaffoldOptions): string[] {
  const set = new Set<string>();
  for (const cls of opts.template.modelClasses) {
    const e = modelClassEntry(cls, opts.providers);
    set.add(e.primary);
    if (e.fallback) set.add(e.fallback);
  }
  return [...set];
}

/** The compose invocation for the chosen mode (repo-relative). */
export function composeFileFor(mode: DeployMode): string {
  return mode === "full"
    ? "-f docker-compose.simple.yml -f docker-compose.dev.full.yml"
    : "-f docker-compose.simple.yml";
}
