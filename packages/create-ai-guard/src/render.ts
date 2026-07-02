import { stringify } from "yaml";
import type { ModelClass, SafetyPreset, Template } from "./templates";

export type Provider = "openai" | "anthropic" | "gemini" | "openrouter" | "azure";
export type DeployMode = "simple" | "full";
export type { SafetyPreset } from "./templates";

export interface ScaffoldOptions {
  projectName: string;
  providers: Provider[];
  mode: DeployMode;
  safetyPreset: SafetyPreset;
  template: Template;
}

const OLLAMA = "ollama/llama3.2:3b";
const PRIMARY: Record<ModelClass, Record<Provider, string>> = {
  cheap: {
    openai: "openai/gpt-4o-mini",
    anthropic: "anthropic/claude-haiku",
    gemini: "gemini/gemini-flash",
    openrouter: "openrouter/openai/gpt-4o-mini",
    azure: "azure/gpt-4o-mini",
  },
  standard: {
    openai: "openai/gpt-4o",
    anthropic: "anthropic/claude-sonnet",
    gemini: "gemini/gemini-pro",
    openrouter: "openrouter/openai/gpt-4o",
    azure: "azure/gpt-4o",
  },
  premium: {
    openai: "openai/gpt-5",
    anthropic: "anthropic/claude-opus",
    gemini: "gemini/gemini-ultra",
    openrouter: "openrouter/anthropic/claude-3.5-sonnet",
    azure: "azure/gpt-4o",
  },
  local: { openai: OLLAMA, anthropic: OLLAMA, gemini: OLLAMA, openrouter: OLLAMA, azure: OLLAMA },
};

// Prices (USD / 1K tokens) for models NOT in Ai-Guard's built-in table, so the
// generated ai-guard.yaml can budget them. Keyed by model string.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "openrouter/openai/gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "openrouter/openai/gpt-4o": { input: 0.0025, output: 0.01 },
  "openrouter/anthropic/claude-3.5-sonnet": { input: 0.003, output: 0.015 },
  "azure/gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "azure/gpt-4o": { input: 0.0025, output: 0.01 },
};

const LOCAL_MODEL = OLLAMA;

/** Resolve primary + optional fallback (a different provider at the same tier). */
function modelClassEntry(cls: ModelClass, providers: Provider[]): { primary: string; fallback?: string } {
  if (cls === "local") return { primary: LOCAL_MODEL };
  const primary = PRIMARY[cls][providers[0]!];
  const alt = providers.find((p) => p !== providers[0]);
  return alt ? { primary, fallback: PRIMARY[cls][alt] } : { primary };
}

/** Build a valid ai-guard.yaml (snake_case) from wizard answers + template. */
export function renderAiGuardYaml(opts: ScaffoldOptions): string {
  const t = opts.template;
  const localOnly = t.localOnly === true;
  const providers = localOnly ? [] : opts.providers;
  const preset: SafetyPreset = localOnly ? "dev" : opts.safetyPreset;
  const injectionModel = localOnly ? LOCAL_MODEL : PRIMARY.cheap[opts.providers[0]!];

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

  // Custom pricing for any used model not in Ai-Guard's built-in table
  // (OpenRouter / Azure) so budgets estimate correctly.
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
            providers.map((p) => [p, { api_key: `env/${p.toUpperCase()}_API_KEY` }]),
          ),
        }
      : {}),
    budgets: {
      global: { monthly_usd: 500, alert_at_percent: 80, hard_stop_at_percent: 100 },
      by_user_type: byUserType,
    },
    features,
    routing: { degrade_at_percent: 80 },
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
    `# Generated by create-ai-guard (${t.id} template). Edit freely.\n` +
    "# Provider api_key env/VAR refs are resolved by the Ai-Guard API at load time.\n\n";
  return header + stringify(config);
}

/** Build a .env with placeholders for the chosen providers + service URLs. */
export function renderEnv(opts: ScaffoldOptions): string {
  const localOnly = opts.template.localOnly === true;
  const lines: string[] = [];
  if (!localOnly) {
    lines.push("# Provider keys (consumed by the LiteLLM proxy)");
    for (const p of opts.providers) {
      lines.push(`${p.toUpperCase()}_API_KEY=`);
      if (p === "azure") {
        lines.push("AZURE_API_BASE=https://<your-resource>.openai.azure.com", "AZURE_API_VERSION=2024-08-01-preview");
      }
    }
    lines.push("");
  }
  lines.push(
    "# LiteLLM proxy",
    "LITELLM_MASTER_KEY=sk-ai-guard-local",
    "",
    "# Ai-Guard API",
    "# Pin to a digest in production — see https://github.com/ai-guard/ai-guard/pkgs/container/ai-guard-api",
    "AI_GUARD_API_IMAGE=ghcr.io/ai-guard/ai-guard-api:latest",
    "PORT=3000",
    "AI_GUARD_API_KEY=sk-ai-guard-api-local",
    "DATABASE_URL=postgres://postgres:postgres@postgres:5432/aiguard",
    "LITELLM_BASE_URL=http://litellm:4000",
    "AI_GUARD_CONFIG=ai-guard.yaml",
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
