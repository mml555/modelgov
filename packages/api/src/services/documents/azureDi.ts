import {
  DocumentClientError,
  DocumentProviderError,
  type DocumentProviderAdapter,
  type DocumentResult,
  type DocumentSource,
} from "./types";
import { readJsonSafe, readTextSafe } from "./util";

export interface AzureDiAdapterOptions {
  /** Azure Document Intelligence resource endpoint, e.g. https://x.cognitiveservices.azure.com */
  endpoint: string;
  /** Ocp-Apim-Subscription-Key. */
  key: string;
  /** USD per page (Azure DI is priced per page). */
  perPageUsd: number;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  /** Overall wall-clock budget for submit + poll. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Injectable for tests; defaults to a real setTimeout delay. */
  sleepImpl?: (ms: number) => Promise<void>;
}

interface AnalyzeResult {
  status?: string;
  error?: { message?: string };
  analyzeResult?: { content?: string; pages?: unknown[] };
}

/**
 * Azure Document Intelligence (prebuilt-read). The analyze API is async: submit
 * returns 202 + an `operation-location`, which is polled to completion. Input
 * `base64` is sent inline (`base64Source`); a `url` (incl. an Azure blob SAS URL)
 * is passed as `urlSource` for the service to pull directly. `s3` is unsupported.
 */
export function createAzureDiAdapter(opts: AzureDiAdapterOptions): DocumentProviderAdapter {
  const doFetch = opts.fetchImpl ?? fetch;
  const apiVersion = opts.apiVersion ?? "2024-11-30";
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const endpoint = opts.endpoint.replace(/\/$/, "");
  const analyzeUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=${apiVersion}`;

  return {
    slug: "azure-di",
    supportedInputs: ["base64", "url"],
    perPageUsd: opts.perPageUsd,
    async extract(source: DocumentSource): Promise<DocumentResult> {
      const body =
        source.kind === "url"
          ? { urlSource: source.url }
          : source.kind === "base64"
            ? { base64Source: source.base64 }
            : null;
      if (!body) {
        throw new DocumentClientError("azure-di supports base64 or url sources only");
      }

      const deadline = Date.now() + timeoutMs;

      let submit: Response;
      try {
        submit = await doFetch(analyzeUrl, {
          method: "POST",
          headers: { "Ocp-Apim-Subscription-Key": opts.key, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new DocumentProviderError(`azure-di submit failed: ${(err as Error).message}`, { cause: err });
      }
      if (submit.status !== 202) {
        const detail = await readTextSafe(submit);
        if (submit.status >= 400 && submit.status < 500) {
          throw new DocumentClientError(`azure-di rejected the document (${submit.status}): ${detail}`);
        }
        throw new DocumentProviderError(`azure-di submit error ${submit.status}: ${detail}`);
      }
      const opLocation = submit.headers.get("operation-location");
      if (!opLocation) {
        throw new DocumentProviderError("azure-di did not return an operation-location");
      }

      // Poll until succeeded/failed or the wall-clock budget is exhausted.
      for (;;) {
        if (Date.now() >= deadline) {
          throw new DocumentProviderError("azure-di analysis timed out");
        }
        await sleep(pollIntervalMs);
        let poll: Response;
        try {
          poll = await doFetch(opLocation, {
            headers: { "Ocp-Apim-Subscription-Key": opts.key },
            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          });
        } catch (err) {
          throw new DocumentProviderError(`azure-di poll failed: ${(err as Error).message}`, { cause: err });
        }
        if (!poll.ok) {
          const detail = await readTextSafe(poll);
          // A 4xx on the operation-location (401 rotated key, 404 expired op) is a
          // permanent client error, not a transient outage — don't advertise it as
          // retryable (parity with the submit path's classification).
          if (poll.status >= 400 && poll.status < 500) {
            throw new DocumentClientError(`azure-di poll rejected (${poll.status}): ${detail}`);
          }
          throw new DocumentProviderError(`azure-di poll error ${poll.status}: ${detail}`);
        }
        const result = await readJsonSafe<AnalyzeResult>(poll);
        const status = result.status;
        if (status === "succeeded") {
          const pages = Array.isArray(result.analyzeResult?.pages)
            ? result.analyzeResult!.pages!.length
            : 1;
          return {
            text: result.analyzeResult?.content ?? "",
            pages: Math.max(1, pages),
            model: "azure-di/prebuilt-read",
            raw: result,
          };
        }
        if (status === "failed") {
          throw new DocumentProviderError(`azure-di analysis failed: ${result.error?.message ?? "unknown error"}`);
        }
        // status running/notStarted → continue polling.
      }
    },
  };
}
