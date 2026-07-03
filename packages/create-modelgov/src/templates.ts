// Starter templates: each is pure data describing the features, user types, and
// model classes a common use case needs. `renderModelgovYaml` turns the chosen
// template into a valid modelgov.yaml, and the framework adapters use
// `primaryFeature` / `examplePrompt` to generate the example route.

export type TemplateId =
  | "support_chat"
  | "document_extraction"
  | "admin_assistant"
  | "saas_tiers"
  | "event_intake"
  | "local_dev"
  | "general_gateway";

export type ModelClass = "cheap" | "standard" | "premium" | "local";
export type SafetyPreset = "dev" | "balanced" | "strict";

export interface TemplateFeature {
  modelClass: ModelClass;
  maxTokens: number;
  /** Overrides the project default safety preset for this feature. */
  safety?: SafetyPreset;
  budgetMonthlyUsd?: number;
  dataSensitivity?: string;
}

export interface TemplateUserType {
  dailyUsd: number;
  dailyRequests: number;
  models: ModelClass[];
}

export interface Template {
  id: TemplateId;
  label: string;
  description: string;
  features: Record<string, TemplateFeature>;
  userTypes: Record<string, TemplateUserType>;
  /** Model classes this template relies on (subset of cheap/standard/premium/local). */
  modelClasses: ModelClass[];
  /** Feature the generated example route calls. */
  primaryFeature: string;
  /** userType the generated example route sends. */
  exampleUserType: string;
  /** Example user message for the generated route. */
  examplePrompt: string;
  /** Data-sensitivity governance, when the template needs it. */
  dataClasses?: Record<string, { allowedModelClasses?: ModelClass[]; allowedProviders?: string[] }>;
  /** Force local (Ollama) provider + dev safety regardless of wizard answers. */
  localOnly?: boolean;
}

export const TEMPLATES: Record<TemplateId, Template> = {
  support_chat: {
    id: "support_chat",
    label: "Support chat — cheap model, PII masking, daily budget",
    description: "A customer-support assistant. Cheap model, per-user daily budget.",
    features: { support_chat: { modelClass: "cheap", maxTokens: 500 } },
    userTypes: {
      anonymous: { dailyUsd: 0.02, dailyRequests: 5, models: ["cheap"] },
      logged_in: { dailyUsd: 0.25, dailyRequests: 50, models: ["cheap", "standard"] },
    },
    modelClasses: ["cheap", "standard"],
    primaryFeature: "support_chat",
    exampleUserType: "logged_in",
    examplePrompt: "How do I reset my password?",
  },
  document_extraction: {
    id: "document_extraction",
    label: "Document extraction — standard model, strict safety, monthly cap",
    description: "Extract structured data from documents. Standard model, strict safety, feature cap.",
    features: {
      document_extraction: { modelClass: "standard", maxTokens: 1500, safety: "strict", budgetMonthlyUsd: 200 },
    },
    userTypes: {
      logged_in: { dailyUsd: 1, dailyRequests: 100, models: ["cheap", "standard"] },
    },
    modelClasses: ["cheap", "standard"],
    primaryFeature: "document_extraction",
    exampleUserType: "logged_in",
    examplePrompt: "Extract the invoice number, date, and total from this document: ...",
  },
  admin_assistant: {
    id: "admin_assistant",
    label: "Admin assistant — premium model for admins only",
    description: "A powerful assistant restricted to admins. Premium model, strict safety.",
    features: { admin_assistant: { modelClass: "premium", maxTokens: 2000, safety: "strict" } },
    userTypes: {
      admin: { dailyUsd: 5, dailyRequests: 500, models: ["cheap", "standard", "premium"] },
    },
    modelClasses: ["cheap", "standard", "premium"],
    primaryFeature: "admin_assistant",
    exampleUserType: "admin",
    examplePrompt: "Summarize this quarter's support tickets and flag anomalies.",
  },
  saas_tiers: {
    id: "saas_tiers",
    label: "SaaS tiers — free vs pro vs enterprise model access",
    description: "Tiered model access by plan. Free gets cheap; pro adds standard; enterprise adds premium.",
    features: { assistant: { modelClass: "cheap", maxTokens: 800 } },
    userTypes: {
      free: { dailyUsd: 0.1, dailyRequests: 20, models: ["cheap"] },
      pro: { dailyUsd: 1, dailyRequests: 200, models: ["cheap", "standard"] },
      enterprise: { dailyUsd: 10, dailyRequests: 2000, models: ["cheap", "standard", "premium"] },
    },
    modelClasses: ["cheap", "standard", "premium"],
    primaryFeature: "assistant",
    exampleUserType: "pro",
    examplePrompt: "Draft a follow-up email to a customer who churned.",
  },
  event_intake: {
    id: "event_intake",
    label: "Event intake — structured extraction from flyers (Jewgo-style)",
    description: "Extract structured event data from user-submitted flyers. Standard model, monthly cap.",
    features: {
      event_extraction: { modelClass: "standard", maxTokens: 1200, safety: "balanced", budgetMonthlyUsd: 100 },
    },
    userTypes: {
      logged_in: { dailyUsd: 0.5, dailyRequests: 50, models: ["cheap", "standard"] },
      admin: { dailyUsd: 5, dailyRequests: 500, models: ["cheap", "standard"] },
    },
    modelClasses: ["cheap", "standard"],
    primaryFeature: "event_extraction",
    exampleUserType: "logged_in",
    examplePrompt: "Extract event title, date, time, venue, and address from this flyer text: ...",
  },
  local_dev: {
    id: "local_dev",
    label: "Local dev — Ollama only, no cloud keys, dev safety",
    description: "Run entirely against local Ollama models. No cloud provider keys required.",
    features: { chat: { modelClass: "local", maxTokens: 500, safety: "dev" } },
    userTypes: {
      logged_in: { dailyUsd: 1, dailyRequests: 1000, models: ["local"] },
    },
    modelClasses: ["local"],
    primaryFeature: "chat",
    exampleUserType: "logged_in",
    examplePrompt: "Say hello and confirm the gateway is working.",
    localOnly: true,
  },
  general_gateway: {
    id: "general_gateway",
    label: "General gateway — one catch-all feature for all AI calls",
    description: "A single permissive feature to route all product AI through Modelgov from day one.",
    features: { ai: { modelClass: "cheap", maxTokens: 1000 } },
    userTypes: {
      anonymous: { dailyUsd: 0.05, dailyRequests: 10, models: ["cheap"] },
      logged_in: { dailyUsd: 1, dailyRequests: 200, models: ["cheap", "standard"] },
    },
    modelClasses: ["cheap", "standard"],
    primaryFeature: "ai",
    exampleUserType: "logged_in",
    examplePrompt: "Write a haiku about rate limiting.",
  },
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];
