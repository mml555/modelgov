import {
  DocumentClientError,
  DocumentProviderError,
  type DocumentProviderAdapter,
  type DocumentResult,
  type DocumentSource,
} from "./types";
import { readJsonSafe, readTextSafe, sourceToBase64 } from "./util";

export interface TesseractAdapterOptions {
  /** Base URL of the Tesseract OCR sidecar (like the Presidio URLs). */
  url: string;
  /** USD per page — typically 0 (self-hosted); still request/budget-governed. */
  perPageUsd: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  urlMaxBytes?: number;
}

/**
 * Self-hosted Tesseract OCR via a sidecar HTTP service (mirrors how Presidio is
 * wired). Contract: `POST {url}/extract { base64 }` → `{ text, pages }`. The
 * gateway sends bytes, so `s3` is unsupported; a `url` source is fetched by the
 * gateway (SSRF-guarded) and forwarded as base64.
 */
export function createTesseractAdapter(opts: TesseractAdapterOptions): DocumentProviderAdapter {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const base = opts.url.replace(/\/$/, "");
  return {
    slug: "tesseract",
    supportedInputs: ["base64", "url"],
    perPageUsd: opts.perPageUsd,
    async extract(source: DocumentSource): Promise<DocumentResult> {
      const base64 = await sourceToBase64(source, doFetch, {
        timeoutMs,
        maxBytes: opts.urlMaxBytes,
      });
      let res: Response;
      try {
        res = await doFetch(`${base}/extract`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ base64 }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new DocumentProviderError(`tesseract request failed: ${(err as Error).message}`, { cause: err });
      }
      if (!res.ok) {
        const detail = await readTextSafe(res);
        if (res.status >= 400 && res.status < 500) {
          throw new DocumentClientError(`tesseract rejected the document (${res.status}): ${detail}`);
        }
        throw new DocumentProviderError(`tesseract error ${res.status}: ${detail}`);
      }
      const body = await readJsonSafe<{ text?: string; pages?: number }>(res);
      return {
        text: body.text ?? "",
        // A document is at least one page; guard against a sidecar returning 0.
        pages: Math.max(1, Math.floor(body.pages ?? 1)),
        model: "tesseract",
        raw: body,
      };
    },
  };
}
