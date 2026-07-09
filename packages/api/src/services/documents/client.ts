import { createAzureDiAdapter } from "./azureDi";
import { createTesseractAdapter } from "./tesseract";
import { createTextractAdapter } from "./textract";
import type { DocumentAiClient, DocumentProviderAdapter } from "./types";

export interface DocumentClientConfig {
  tesseract?: { url: string; perPageUsd: number };
  azureDi?: { endpoint: string; key: string; perPageUsd: number; apiVersion?: string };
  textract?: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    perPageUsd: number;
    s3AllowedBuckets?: readonly string[];
  };
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Bound on a gateway-fetched (`url` source) document. */
  urlMaxBytes?: number;
}

/**
 * Build the document-AI client from the enabled providers. A provider is enabled
 * iff its credentials/endpoint are configured; an unconfigured provider is simply
 * absent from the registry, so the route returns 400 `provider_unavailable`.
 */
export function createDocumentClient(cfg: DocumentClientConfig): DocumentAiClient {
  const adapters = new Map<string, DocumentProviderAdapter>();
  if (cfg.tesseract) {
    adapters.set(
      "tesseract",
      createTesseractAdapter({ ...cfg.tesseract, fetchImpl: cfg.fetchImpl, urlMaxBytes: cfg.urlMaxBytes }),
    );
  }
  if (cfg.azureDi) {
    adapters.set("azure-di", createAzureDiAdapter({ ...cfg.azureDi, fetchImpl: cfg.fetchImpl }));
  }
  if (cfg.textract) {
    adapters.set(
      "textract",
      createTextractAdapter({ ...cfg.textract, fetchImpl: cfg.fetchImpl, urlMaxBytes: cfg.urlMaxBytes }),
    );
  }
  return {
    providers: () => [...adapters.keys()],
    get: (provider) => adapters.get(provider),
  };
}
