import { PROVIDER_REGISTRY } from "@modelgov/policy-engine";
import { WIZARD_PROVIDERS, type Provider } from "create-modelgov/render";
import { TEMPLATE_IDS, TEMPLATES, type TemplateId } from "create-modelgov/templates";

export type BackendMode = "demo" | "cloud" | "local";

/** One-click preset for first-time users: demo AI + support chat template. */
// Recommended starting point for a real setup: connect a real provider (OpenAI
// by default) with a support-chat template, balanced safety, and a spend cap —
// so budgets and cost governance are real from the first request. The operator
// only needs to paste a key. (Demo mode stays available as a secondary
// "just exploring" option, but it isn't the recommendation — with fake tokens
// there is no cost to govern, which is the whole point of the gateway.)
export const BEGINNER_PRESET = {
  templateId: "support_chat" as TemplateId,
  backend: "cloud" as BackendMode,
  safety: "balanced" as const,
  monthlyBudget: 200,
};

export interface ProviderGroup {
  id: string;
  title: string;
  description: string;
  providers: Provider[];
}

/** Plain-language groupings for the setup wizard (all supported providers). */
export const PROVIDER_GROUPS: ProviderGroup[] = [
  {
    id: "popular",
    title: "Direct API keys",
    description: "Create an account with the provider, copy an API key, paste it on the next step.",
    providers: ["openai", "anthropic", "gemini", "groq", "mistral", "xai", "deepseek", "cohere"],
  },
  {
    id: "router",
    title: "One key, many models",
    description: "OpenRouter routes to OpenAI, Anthropic, and others through a single API key.",
    providers: ["openrouter"],
  },
  {
    id: "enterprise",
    title: "Company cloud (Azure & AWS)",
    description: "Use models deployed in your organization's Azure or AWS account.",
    providers: ["azure", "azure_ai", "bedrock", "vertex_ai"],
  },
  {
    id: "subscription",
    title: "Subscription-based",
    description: "GitHub Copilot uses your existing Copilot subscription (not pay-per-token).",
    providers: ["github_copilot"],
  },
];

export const ALL_WIZARD_PROVIDERS = WIZARD_PROVIDERS;

export const TEMPLATE_CHOICES = TEMPLATE_IDS.map((id) => ({
  id,
  title: friendlyTemplateTitle(id),
  description: TEMPLATES[id].description,
  localOnly: TEMPLATES[id].localOnly === true,
  recommended: id === "support_chat",
}));

function friendlyTemplateTitle(id: TemplateId): string {
  const t = TEMPLATES[id];
  const short = t.label.split("—")[0]?.trim() ?? t.label;
  return short;
}

export const BACKEND_OPTIONS: {
  id: BackendMode;
  title: string;
  description: string;
  badge?: string;
}[] = [
  {
    id: "cloud",
    title: "Connect a real AI provider",
    description: "OpenAI, Anthropic, Google, Azure, AWS, Groq, and 10+ more — real models with real spend governance. Pick one or several on the next step.",
    badge: "Recommended",
  },
  {
    id: "local",
    title: "Run models on this computer (Ollama)",
    description: "Free local models via Ollama. Requires Ollama installed; we will show the one terminal command to enable it.",
  },
  {
    id: "demo",
    title: "Just exploring? Use the built-in demo",
    description: "No sign-ups, no API keys — a fake AI runs locally. Good for a quick look or offline dev, but budgets and cost tracking aren't meaningful (the tokens are free).",
  },
];

/** Providers where tight free tiers make hybrid injection especially helpful. */
export const FREE_TIER_INJECTION_PROVIDERS: Provider[] = ["gemini", "groq"];

export function shouldShowHybridInjectionGuidance(opts: {
  useCloud: boolean;
  safety: "dev" | "balanced" | "strict";
  providers: Provider[];
}): boolean {
  return (
    opts.useCloud
    && opts.safety !== "dev"
    && opts.providers.some((p) => FREE_TIER_INJECTION_PROVIDERS.includes(p))
  );
}

export const HYBRID_INJECTION_GUIDANCE = {
  title: "Free-tier tip: hybrid injection screening",
  summary:
    "With safety on, each message normally needs two model calls (injection check + reply). On tight free tiers that adds up fast during setup.",
  detail:
    "For local development we route the injection check through the built-in demo model, so only your real chats hit your API key. This applies automatically when you finish the wizard.",
};

export const SAFETY_OPTIONS: {
  id: "dev" | "balanced" | "strict";
  title: string;
  description: string;
}[] = [
  {
    id: "dev",
    title: "Off (development only)",
    description: "No PII or injection blocking. Use only on your laptop while experimenting.",
  },
  {
    id: "balanced",
    title: "Balanced (recommended)",
    description: "Mask personal data in logs; block obvious prompt-injection attacks.",
  },
  {
    id: "strict",
    title: "Strict",
    description: "Block requests or responses that contain personal data. Best for regulated data.",
  },
];

export const BUDGET_PRESETS = [
  { value: 50, label: "$50 / month" },
  { value: 200, label: "$200 / month" },
  { value: 500, label: "$500 / month" },
  { value: 2000, label: "$2,000 / month" },
  { value: 10000, label: "$10,000 / month" },
];

/** Human labels for credential fields (never show raw env var names as the primary label). */
export const CREDENTIAL_FIELDS: Record<
  string,
  { label: string; help: string; placeholder: string }
> = {
  OPENAI_API_KEY: {
    label: "OpenAI API key",
    help: "platform.openai.com → API keys → Create key",
    placeholder: "sk-...",
  },
  ANTHROPIC_API_KEY: {
    label: "Anthropic API key",
    help: "console.anthropic.com → API keys",
    placeholder: "sk-ant-...",
  },
  GEMINI_API_KEY: {
    label: "Google Gemini API key",
    help: "aistudio.google.com → Get API key. Free tier is tight (~20 requests/day per model); the wizard uses hybrid injection screening to save quota.",
    placeholder: "AIza...",
  },
  OPENROUTER_API_KEY: {
    label: "OpenRouter API key",
    help: "openrouter.ai → Keys",
    placeholder: "sk-or-...",
  },
  AZURE_API_KEY: {
    label: "Azure OpenAI API key",
    help: "Your Azure OpenAI resource key",
    placeholder: "Paste key",
  },
  AZURE_API_BASE: {
    label: "Azure OpenAI endpoint URL",
    help: "e.g. https://your-resource.openai.azure.com",
    placeholder: "https://....openai.azure.com",
  },
  AZURE_API_VERSION: {
    label: "Azure API version",
    help: "Usually 2024-08-01-preview (from Azure portal)",
    placeholder: "2024-08-01-preview",
  },
  AZURE_AI_API_KEY: {
    label: "Azure AI Foundry API key",
    help: "From your Foundry project in Azure AI Studio",
    placeholder: "Paste key",
  },
  AZURE_AI_API_BASE: {
    label: "Azure AI Foundry endpoint",
    help: "e.g. https://your-resource.services.ai.azure.com",
    placeholder: "https://....services.ai.azure.com",
  },
  AWS_ACCESS_KEY_ID: {
    label: "AWS access key ID",
    help: "IAM user or role with Bedrock access",
    placeholder: "AKIA...",
  },
  AWS_SECRET_ACCESS_KEY: {
    label: "AWS secret access key",
    help: "Paired with the access key above",
    placeholder: "Paste secret",
  },
  AWS_SESSION_TOKEN: {
    label: "AWS session token (optional)",
    help: "Only if you use temporary STS credentials",
    placeholder: "Leave blank if unsure",
  },
  AWS_REGION_NAME: {
    label: "AWS region",
    help: "Region where Bedrock is enabled, e.g. us-east-1",
    placeholder: "us-east-1",
  },
  GOOGLE_APPLICATION_CREDENTIALS: {
    label: "Google service account JSON path",
    // The Vertex call is made by the litellm container, so this path must resolve
    // INSIDE it — mount the JSON file into the litellm service (compose volume or
    // Helm secret). The one-command local stack can't mount an arbitrary host
    // path, so Vertex is best set up via a compose override / Helm. See docs.
    help: "Path to the service-account JSON — must be mounted into the litellm container (see docs/providers.md)",
    placeholder: "/secrets/vertex-sa.json",
  },
  VERTEX_PROJECT: {
    label: "Google Cloud project ID",
    help: "The GCP project with Vertex AI enabled",
    placeholder: "my-gcp-project",
  },
  VERTEX_LOCATION: {
    label: "Vertex region",
    help: "e.g. us-central1",
    placeholder: "us-central1",
  },
  MISTRAL_API_KEY: {
    label: "Mistral API key",
    help: "console.mistral.ai → API keys",
    placeholder: "Paste key",
  },
  GROQ_API_KEY: {
    label: "Groq API key",
    help: "console.groq.com → API keys",
    placeholder: "gsk_...",
  },
  XAI_API_KEY: {
    label: "xAI API key",
    help: "console.x.ai",
    placeholder: "xai-...",
  },
  DEEPSEEK_API_KEY: {
    label: "DeepSeek API key",
    help: "platform.deepseek.com",
    placeholder: "sk-...",
  },
  COHERE_API_KEY: {
    label: "Cohere API key",
    help: "dashboard.cohere.com → API keys",
    placeholder: "Paste key",
  },
  GITHUB_COPILOT_TOKEN: {
    label: "GitHub Copilot token (optional)",
    help: "Usually auto-configured on first use; paste only for headless setups",
    placeholder: "Leave blank to use device login",
  },
};

export function credentialFieldsForProviders(providers: Provider[]) {
  const fields: {
    provider: Provider;
    providerLabel: string;
    key: string;
    label: string;
    help: string;
    placeholder: string;
    optional: boolean;
  }[] = [];

  for (const p of providers) {
    const spec = PROVIDER_REGISTRY[p];
    const providerLabel = spec?.label ?? p;
    for (const envVar of spec?.credentialEnvVars ?? []) {
      if (fields.some((f) => f.key === envVar)) continue;
      const meta = CREDENTIAL_FIELDS[envVar] ?? {
        label: envVar.replace(/_/g, " ").toLowerCase(),
        help: "From your provider's dashboard",
        placeholder: "Paste value",
      };
      fields.push({
        provider: p,
        providerLabel,
        key: envVar,
        label: meta.label,
        help: meta.help,
        placeholder: meta.placeholder,
        optional: envVar === "AWS_SESSION_TOKEN" || envVar === "GITHUB_COPILOT_TOKEN",
      });
    }
  }
  return fields;
}

export function providerSummary(providers: Provider[]): string {
  return providers.map((p) => PROVIDER_REGISTRY[p]?.label ?? p).join(", ");
}
