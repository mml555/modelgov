import type {
  FeatureName,
  ModelClassName,
  UserTypeName,
} from "./generated/config-types";

export type { FeatureName, ModelClassName, UserTypeName };

/** A text segment of a multimodal message. */
export interface TextPart {
  type: "text";
  text: string;
}

/**
 * An image segment of a multimodal message. `url` is an http(s) URL or a
 * `data:` URI (base64) — e.g. a page scan for OCR. Passed through to a vision
 * model; the gateway still governs budget, audit, and text-part safety.
 */
export interface ImagePart {
  type: "image_url";
  image_url: { url: string; detail?: "low" | "high" | "auto" };
}

export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | (string & {});
  /** A plain string, or OpenAI-style content parts (text + images) for vision. */
  content: string | ContentPart[];
}

/**
 * A chat request. `feature` and `userType` are REQUIRED — omitting either is a
 * compile-time error, which is how Ai-Guard enforces "every call declares its
 * feature" at the SDK boundary (the API also rejects it at runtime).
 *
 * `FeatureName`, `UserTypeName`, and `ModelClassName` are generated from
 * `ai-guard.yaml` via `pnpm generate-sdk-types`.
 */
export interface ChatRequest {
  userId: string;
  userType: UserTypeName;
  feature: FeatureName;
  messages: ChatMessage[];
  modelClass?: ModelClassName;
  /**
   * Retrieved context passages for a grounded feature (safety `grounding:
   * strict`). The gateway answers ONLY from these, forces verbatim citations,
   * and verifies them — unverifiable answers become a safe refusal.
   */
  context?: string[];
  inputTokensEstimate?: number;
  temperature?: number;
  projectId?: string;
  environment?: string;
  metadata?: Record<string, unknown>;
}

export interface BudgetRemaining {
  userDailyUsd: number;
  featureMonthlyUsd: number | null;
  /** null when no global monthly cap is configured (monthly_usd: 0). */
  globalMonthlyUsd: number | null;
  /** Token headroom; present when a token cap is configured, null otherwise. */
  userDailyTokens?: number | null;
  featureMonthlyTokens?: number | null;
  globalMonthlyTokens?: number | null;
}

export interface ChatResponse {
  message: { role: string; content: string };
  model: string;
  /** Provider of the model that ran, e.g. "openai", "openrouter", "azure", "ollama". */
  provider: string;
  decision: "allow" | "degrade" | "fallback";
  reason?: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  cost: { estimatedUsd: number; actualUsd: number };
  budgetRemaining: BudgetRemaining;
  /** `grounded` is present only for grounded features: whether the answer's
   * citations were verified against the provided context. */
  safety: { piiMasked: boolean; injectionBlocked: boolean; grounded?: boolean };
  /** Audit log id for `ai-guard requests show`. */
  requestId: string;
}

export interface ExplainRequest {
  userId: string;
  userType: UserTypeName;
  feature: FeatureName;
  modelClass?: ModelClassName;
  inputTokensEstimate?: number;
  projectId?: string;
  environment?: string;
}

/**
 * A governed embeddings request. Like `chat`, `feature` and `userType` are
 * REQUIRED so every embedding call declares its purpose and is policy-checked
 * (budget, model routing, audit) before the provider runs.
 */
export interface EmbeddingsRequest {
  userId: string;
  userType: UserTypeName;
  feature: FeatureName;
  /** One text or a batch of texts to embed. */
  input: string | string[];
  modelClass?: ModelClassName;
  inputTokensEstimate?: number;
  projectId?: string;
  environment?: string;
  metadata?: Record<string, unknown>;
}

export interface EmbeddingsResponse {
  /** One vector per input, in request order. */
  embeddings: number[][];
  model: string;
  provider: string;
  decision: "allow" | "degrade" | "fallback";
  reason?: string;
  usage: { inputTokens: number | null };
  cost: { estimatedUsd: number; actualUsd: number };
  budgetRemaining: BudgetRemaining | null;
  requestId: string;
}

export interface ExplainResponse {
  decision: "allow" | "block" | "degrade" | "fallback";
  reason?: string;
  requested: {
    userId: string;
    userType: string;
    feature: string;
    modelClass: string;
  };
  resolved: {
    modelClass: string;
    model: string;
    provider: string;
    fallbackModel?: string;
  };
  safety: {
    preset: string;
    pii: string;
    promptInjection: string;
    maxOutputTokens: number;
  };
  cost: { estimatedUsd: number };
  budget: {
    remaining: BudgetRemaining;
    used: {
      userDailyUsd: number;
      userDailyRequests: number;
      featureMonthlyUsd: number;
      globalMonthlyUsd: number;
    };
    permittedModels: string[];
    dailyRequestLimit: number;
    dailyRequestsRemaining: number;
  };
  wouldCallModel: boolean;
  summary: string;
}
