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
 * compile-time error, which is how Modelgov enforces "every call declares its
 * feature" at the SDK boundary (the API also rejects it at runtime).
 *
 * `FeatureName`, `UserTypeName`, and `ModelClassName` are generated from
 * `modelgov.yaml` via `pnpm generate-sdk-types`.
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
  /** Audit log id for `modelgov requests show`. */
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

/** A document to extract text from — exactly one source. */
export type DocumentSource = { base64: string } | { url: string } | { s3: string };

/** One cell of an extracted table (0-indexed). */
export interface DocumentTableCell {
  rowIndex: number;
  columnIndex: number;
  content: string;
  rowSpan?: number;
  columnSpan?: number;
}
export interface DocumentTable {
  rowCount: number;
  columnCount: number;
  cells: DocumentTableCell[];
}
export interface DocumentField {
  content?: string;
  value?: string | number | boolean | null;
  type?: string;
  confidence?: number;
}
export interface DocumentEntity {
  docType?: string;
  confidence?: number;
  fields: Record<string, DocumentField>;
}

export interface DocumentExtractRequest {
  /** Governed provider slug: "tesseract" | "azure-di" | "textract" (must be configured). */
  provider: string;
  userId: string;
  userType: UserTypeName;
  feature: FeatureName;
  document: DocumentSource;
  modelClass?: ModelClassName;
  /**
   * Provider model to run — only providers that support model selection accept
   * it. Azure DI: "prebuilt-read" (default), "prebuilt-layout" (tables),
   * "prebuilt-invoice", "prebuilt-bankStatement.us", or a custom model id.
   */
  model?: string;
  /** Caller estimate of page count, used for the pre-call budget reserve. */
  pages?: number;
  projectId?: string;
  environment?: string;
  metadata?: Record<string, unknown>;
}

export interface DocumentExtractResponse {
  /** Extracted text (PII-masked per the feature's plan). */
  text: string;
  pages: number;
  provider: string;
  model?: string;
  /** Structure-aware model output (Azure DI prebuilt-layout / prebuilt-*). */
  tables?: DocumentTable[];
  fields?: Record<string, DocumentField>;
  documents?: DocumentEntity[];
  decision: "allow" | "degrade";
  reason?: string;
  cost: { estimatedUsd: number; actualUsd: number };
  budgetRemaining: BudgetRemaining | null;
  safety: { piiMasked: boolean };
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

// --- Usage / transactions / provider health --------------------------------

/** Query for `getUsage` (`GET /v1/usage`). */
export interface UsageQuery {
  userId?: string;
  feature?: string;
  projectId?: string;
}

/** Query for `getUsageSummary` (`GET /v1/usage/summary`). */
export interface UsageSummaryQuery {
  feature?: string;
  userType?: string;
  /** "24h", "7d", or an ISO-8601 timestamp (default "24h" server-side). */
  since?: string;
  projectId?: string;
}

/**
 * The `/v1/usage` and `/v1/usage/summary` bodies are operator-facing and not
 * fully fixed in the OpenAPI spec, so they are typed as a loose record.
 */
export type UsageResponse = Record<string, unknown>;

/** Query for `getUsageTransactions` (`GET /v1/usage/transactions`). */
export interface TransactionsQuery {
  /** "24h", "7d", or an ISO-8601 timestamp (default "24h" server-side). */
  since?: string;
  /** Max transactions to return (1-200; top-N by cost). */
  limit?: number;
  projectId?: string;
}

/**
 * One correlation-id transaction in the cost rollup. Groups every request and
 * externally-ingested cost event sharing an `x-request-id` (the
 * `correlationId`), with LLM vs external cost broken out.
 */
export interface Transaction {
  correlationId: string;
  requests: number;
  externalEvents: number;
  actualCostUsd: number;
  llmCostUsd: number;
  externalCostUsd: number;
  estimatedCostUsd: number;
  firstSeen: string;
  lastSeen: string;
}

/** `200` body of `GET /v1/usage/transactions`. */
export interface TransactionsResponse {
  since: string;
  limit: number;
  transactions: Transaction[];
}

export interface ProviderModelHealth {
  model: string;
  provider: string;
  healthy: boolean;
  error?: string;
}

/** `200` body of `GET /v1/admin/providers/health`. */
export interface ProviderHealthResponse {
  status: "ok" | "degraded" | "fail" | "skipped";
  models: ProviderModelHealth[];
}
