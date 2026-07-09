// Document-AI provider client — the SECOND egress. Unlike LLM traffic (which the
// gateway hands to the LiteLLM proxy), OCR / document-extraction services
// (Tesseract, Azure Document Intelligence, and later Textract) are not LLM-chat,
// so the gateway calls them directly through these adapters. Mirrors the shape of
// services/litellm.ts: an interface + injected implementation + a test mock.

/** A document to extract text from. Exactly one source kind per request. */
export type DocumentSource =
  | { kind: "base64"; base64: string }
  | { kind: "url"; url: string }
  | { kind: "s3"; s3: string };

export type DocumentInputKind = DocumentSource["kind"];

export interface DocumentResult {
  /** Extracted plain text (concatenated across pages). */
  text: string;
  /** Pages the provider actually processed — the billing quantity. */
  pages: number;
  /** Provider/model identifier stamped on the audit row's resolved_model. */
  model?: string;
  raw?: unknown;
}

export interface DocumentProviderAdapter {
  /** Provider slug, e.g. "tesseract", "azure-di". */
  readonly slug: string;
  /** Which document source kinds this provider accepts. */
  readonly supportedInputs: readonly DocumentInputKind[];
  /** USD per page — the cost basis for reserve/settle (0 for self-hosted). */
  readonly perPageUsd: number;
  extract(source: DocumentSource): Promise<DocumentResult>;
}

/** The set of enabled document providers, selected by env config. */
export interface DocumentAiClient {
  /** Enabled provider slugs. */
  providers(): string[];
  /** The adapter for a slug, or undefined when the provider is not configured. */
  get(provider: string): DocumentProviderAdapter | undefined;
}

/**
 * A transient provider failure (5xx / network) — retryable. Mirrors
 * litellm's `ProviderError` so the service maps it the same way (502, retryable).
 */
export class DocumentProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DocumentProviderError";
  }
}

/**
 * A 4xx from the provider (bad document / config) — NOT retryable. Mirrors
 * litellm's `LiteLLMClientError`.
 */
export class DocumentClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DocumentClientError";
  }
}
