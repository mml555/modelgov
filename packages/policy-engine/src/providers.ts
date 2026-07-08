// ── Provider registry: the single source of truth for provider metadata ──────
//
// Modelgov never calls a provider directly — it evaluates policy and hands
// execution to a LiteLLM proxy, which owns credentials + routing. This registry
// therefore holds only DECLARATIVE metadata (no formatting/yaml/HTTP logic, so
// the engine stays pure). It is consumed by:
//   - cost.ts          → built-in PRICE_TABLE + subscription detection
//   - the API layer    → the env-credential allowlist (loadConfig.ts)
//   - the CLI doctor   → per-provider credential checks
//   - create-modelgov  → wizard presets (default models, prices, env vars)
//
// Adding a provider is one entry here (+ the wizard's UI option) rather than the
// ~9 scattered edits it used to take. The provider *slug* MUST equal the LiteLLM
// model-string prefix (the part before the first "/"), because `providerOf()`
// derives it by splitting on "/".

import { providerOf } from "./routing";
import type { ModelPrice } from "./cost";

/**
 * How a provider authenticates. Modelgov does not perform any of these itself —
 * LiteLLM does. The kind drives which credential env vars the wizard emits and
 * the allowlist admits, and how the wizard writes the LiteLLM `litellm_params`.
 */
export type AuthKind = "api_key" | "aws" | "gcp" | "oauth_device" | "local";

/**
 * How a provider bills. `per_token` is the norm. `subscription` (e.g. GitHub
 * Copilot's per-seat plan) has NO per-token cost, so modelgov reserves $0 USD
 * for it and governs it purely with token- and request-count budgets.
 */
export type BillingKind = "per_token" | "subscription";

export interface ProviderSpec {
  /** LiteLLM model-string prefix, e.g. "bedrock", "github_copilot". */
  slug: string;
  /** Display name for the wizard + docs. */
  label: string;
  authKind: AuthKind;
  billingKind: BillingKind;
  /**
   * Credential env vars this provider's LiteLLM wiring reads. Used by the API
   * allowlist (so an `env/VAR` ref in `providers:` resolves) and the wizard
   * (which env keys to scaffold). Empty for local/OAuth providers with no key.
   */
  credentialEnvVars: string[];
  /** Default model string per class, for the wizard's PRIMARY presets. */
  defaultModels?: Partial<Record<"cheap" | "standard" | "premium", string>>;
  /**
   * Built-in per-1k-token prices, keyed by full model string. Merged into the
   * global PRICE_TABLE. Subscription providers have no prices (they reserve $0).
   */
  prices?: Record<string, ModelPrice>;
}

// Prices are USD per 1K tokens. Values for the long-standing providers
// (openai/anthropic/gemini/azure/azure_ai) are unchanged from the previous
// hand-written PRICE_TABLE. Prices for the newer providers are best-effort
// snapshots — operators can always override any of them via modelgov.yaml
// `pricing:`. When a provider's real rate matters for USD budgets, verify it
// against the provider's pricing page and add/override a `pricing` entry.
export const PROVIDER_REGISTRY: Record<string, ProviderSpec> = {
  openai: {
    slug: "openai",
    label: "OpenAI",
    authKind: "api_key",
    billingKind: "per_token",
    credentialEnvVars: ["OPENAI_API_KEY"],
    defaultModels: { cheap: "openai/gpt-4o-mini", standard: "openai/gpt-4o", premium: "openai/gpt-5" },
    prices: {
      "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
      "openai/gpt-4.1-mini": { inputPer1k: 0.0004, outputPer1k: 0.0016 },
      "openai/gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01 },
      "openai/gpt-5": { inputPer1k: 0.00125, outputPer1k: 0.01 },
    },
  },
  anthropic: {
    slug: "anthropic",
    label: "Anthropic",
    authKind: "api_key",
    billingKind: "per_token",
    credentialEnvVars: ["ANTHROPIC_API_KEY"],
    defaultModels: { cheap: "anthropic/claude-haiku", standard: "anthropic/claude-sonnet", premium: "anthropic/claude-opus" },
    prices: {
      "anthropic/claude-sonnet": { inputPer1k: 0.003, outputPer1k: 0.015 },
      "anthropic/claude-opus": { inputPer1k: 0.015, outputPer1k: 0.075 },
      "anthropic/claude-haiku": { inputPer1k: 0.0008, outputPer1k: 0.004 },
    },
  },
  gemini: {
    slug: "gemini",
    label: "Google Gemini (AI Studio)",
    authKind: "api_key",
    billingKind: "per_token",
    credentialEnvVars: ["GEMINI_API_KEY"],
    defaultModels: { cheap: "gemini/gemini-flash", standard: "gemini/gemini-pro", premium: "gemini/gemini-ultra" },
    prices: {
      "gemini/gemini-flash": { inputPer1k: 0.000075, outputPer1k: 0.0003 },
      "gemini/gemini-pro": { inputPer1k: 0.00125, outputPer1k: 0.005 },
    },
  },
  openrouter: {
    slug: "openrouter",
    label: "OpenRouter",
    authKind: "api_key",
    billingKind: "per_token",
    credentialEnvVars: ["OPENROUTER_API_KEY"],
    defaultModels: {
      cheap: "openrouter/openai/gpt-4o-mini",
      standard: "openrouter/openai/gpt-4o",
      premium: "openrouter/anthropic/claude-3.5-sonnet",
    },
    // Priced per-deployment via modelgov.yaml `pricing:` (the wizard emits it).
  },
  azure: {
    slug: "azure",
    label: "Azure OpenAI",
    authKind: "api_key",
    billingKind: "per_token",
    // Model = your deployment name; endpoint + api version alongside the key.
    credentialEnvVars: ["AZURE_API_KEY", "AZURE_API_BASE", "AZURE_API_VERSION"],
    defaultModels: { cheap: "azure/gpt-4o-mini", standard: "azure/gpt-4o", premium: "azure/gpt-4o" },
    prices: {
      "azure/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
      "azure/gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01 },
      "azure/gpt-5": { inputPer1k: 0.00125, outputPer1k: 0.01 },
    },
  },
  azure_ai: {
    slug: "azure_ai",
    label: "Azure AI Foundry",
    authKind: "api_key",
    billingKind: "per_token",
    credentialEnvVars: ["AZURE_AI_API_KEY", "AZURE_AI_API_BASE"],
    defaultModels: { cheap: "azure_ai/gpt-4o-mini", standard: "azure_ai/gpt-4o", premium: "azure_ai/claude-opus-4-1" },
    prices: {
      "azure_ai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
      "azure_ai/gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01 },
      "azure_ai/gpt-5": { inputPer1k: 0.00125, outputPer1k: 0.01 },
      "azure_ai/claude-opus-4-1": { inputPer1k: 0.015, outputPer1k: 0.075 },
    },
  },

  // ── Newly first-class providers ──────────────────────────────────────────
  github_copilot: {
    slug: "github_copilot",
    label: "GitHub Copilot",
    // LiteLLM performs the OAuth device flow and caches the token; a headless
    // proxy can be pre-provisioned via GITHUB_COPILOT_TOKEN (see docs).
    authKind: "oauth_device",
    // Per-seat subscription: no per-token cost, so USD is not reserved. Governed
    // by token- and request-count budgets instead (see cost.ts / evaluator).
    billingKind: "subscription",
    credentialEnvVars: ["GITHUB_COPILOT_TOKEN"],
    defaultModels: {
      cheap: "github_copilot/gpt-4o-mini",
      standard: "github_copilot/gpt-4o",
      premium: "github_copilot/claude-3.5-sonnet",
    },
    // No prices: subscription-billed, so the reservation is $0.
  },
  bedrock: {
    slug: "bedrock",
    label: "AWS Bedrock",
    authKind: "aws",
    billingKind: "per_token",
    credentialEnvVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION_NAME"],
    defaultModels: {
      cheap: "bedrock/anthropic.claude-3-5-haiku-20241022-v1:0",
      standard: "bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0",
      premium: "bedrock/anthropic.claude-3-opus-20240229-v1:0",
    },
    prices: {
      "bedrock/anthropic.claude-3-5-haiku-20241022-v1:0": { inputPer1k: 0.0008, outputPer1k: 0.004 },
      "bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0": { inputPer1k: 0.003, outputPer1k: 0.015 },
      "bedrock/anthropic.claude-3-opus-20240229-v1:0": { inputPer1k: 0.015, outputPer1k: 0.075 },
    },
  },
  vertex_ai: {
    slug: "vertex_ai",
    label: "Google Vertex AI",
    authKind: "gcp",
    billingKind: "per_token",
    credentialEnvVars: ["GOOGLE_APPLICATION_CREDENTIALS", "VERTEX_PROJECT", "VERTEX_LOCATION"],
    defaultModels: {
      cheap: "vertex_ai/gemini-1.5-flash",
      standard: "vertex_ai/gemini-1.5-pro",
      premium: "vertex_ai/gemini-1.5-pro",
    },
    prices: {
      "vertex_ai/gemini-1.5-flash": { inputPer1k: 0.000075, outputPer1k: 0.0003 },
      "vertex_ai/gemini-1.5-pro": { inputPer1k: 0.00125, outputPer1k: 0.005 },
    },
  },
  mistral: {
    slug: "mistral",
    label: "Mistral",
    authKind: "api_key",
    billingKind: "per_token",
    credentialEnvVars: ["MISTRAL_API_KEY"],
    defaultModels: {
      cheap: "mistral/mistral-small-latest",
      standard: "mistral/mistral-large-latest",
      premium: "mistral/mistral-large-latest",
    },
    prices: {
      "mistral/mistral-small-latest": { inputPer1k: 0.0002, outputPer1k: 0.0006 },
      "mistral/mistral-large-latest": { inputPer1k: 0.002, outputPer1k: 0.006 },
    },
  },
  groq: {
    slug: "groq",
    label: "Groq",
    authKind: "api_key",
    billingKind: "per_token",
    credentialEnvVars: ["GROQ_API_KEY"],
    defaultModels: {
      cheap: "groq/llama-3.1-8b-instant",
      standard: "groq/llama-3.3-70b-versatile",
      premium: "groq/llama-3.3-70b-versatile",
    },
    prices: {
      "groq/llama-3.1-8b-instant": { inputPer1k: 0.00005, outputPer1k: 0.00008 },
      "groq/llama-3.3-70b-versatile": { inputPer1k: 0.00059, outputPer1k: 0.00079 },
    },
  },
  xai: {
    slug: "xai",
    label: "xAI (Grok)",
    authKind: "api_key",
    billingKind: "per_token",
    credentialEnvVars: ["XAI_API_KEY"],
    defaultModels: {
      cheap: "xai/grok-2-latest",
      standard: "xai/grok-2-latest",
      premium: "xai/grok-2-latest",
    },
    prices: {
      "xai/grok-2-latest": { inputPer1k: 0.002, outputPer1k: 0.01 },
    },
  },
  deepseek: {
    slug: "deepseek",
    label: "DeepSeek",
    authKind: "api_key",
    billingKind: "per_token",
    credentialEnvVars: ["DEEPSEEK_API_KEY"],
    defaultModels: {
      cheap: "deepseek/deepseek-chat",
      standard: "deepseek/deepseek-chat",
      premium: "deepseek/deepseek-reasoner",
    },
    prices: {
      "deepseek/deepseek-chat": { inputPer1k: 0.00027, outputPer1k: 0.0011 },
      "deepseek/deepseek-reasoner": { inputPer1k: 0.00055, outputPer1k: 0.00219 },
    },
  },
  cohere: {
    slug: "cohere",
    label: "Cohere",
    authKind: "api_key",
    billingKind: "per_token",
    credentialEnvVars: ["COHERE_API_KEY"],
    defaultModels: {
      cheap: "cohere/command-r",
      standard: "cohere/command-r-plus",
      premium: "cohere/command-r-plus",
    },
    prices: {
      "cohere/command-r": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
      "cohere/command-r-plus": { inputPer1k: 0.0025, outputPer1k: 0.01 },
    },
  },

  // Local runtimes: no key, price-exempt (governed by token budgets).
  ollama: {
    slug: "ollama",
    label: "Ollama (local)",
    authKind: "local",
    billingKind: "per_token",
    credentialEnvVars: [],
  },
};

/** The ProviderSpec for a model string, or undefined for an unknown provider. */
export function providerSpecOf(model: string): ProviderSpec | undefined {
  return PROVIDER_REGISTRY[providerOf(model)];
}

/**
 * True when a model routes to a subscription-billed provider (e.g. GitHub
 * Copilot). Such models reserve $0 USD; token/request budgets still apply.
 */
export function isSubscriptionModel(model: string): boolean {
  return providerSpecOf(model)?.billingKind === "subscription";
}

/** Every credential env var referenced by any registered provider. */
export function providerCredentialEnvVars(): string[] {
  const vars = new Set<string>();
  for (const spec of Object.values(PROVIDER_REGISTRY)) {
    for (const v of spec.credentialEnvVars) vars.add(v);
  }
  return [...vars];
}

/** Merge every provider's built-in prices into one table (keyed by model string). */
export function buildBuiltinPriceTable(): Record<string, ModelPrice> {
  const table: Record<string, ModelPrice> = {};
  for (const spec of Object.values(PROVIDER_REGISTRY)) {
    if (spec.prices) Object.assign(table, spec.prices);
  }
  return table;
}
