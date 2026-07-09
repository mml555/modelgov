import { signAwsV4 } from "./sigv4";
import {
  DocumentClientError,
  DocumentProviderError,
  type DocumentProviderAdapter,
  type DocumentResult,
  type DocumentSource,
} from "./types";
import { readJsonSafe, sourceToBase64 } from "./util";

export interface TextractAdapterOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** USD per page (Textract DetectDocumentText ≈ $0.0015/page). */
  perPageUsd: number;
  /**
   * Buckets a caller may reference via an `s3` source. The gateway reads S3 with
   * its own credentials, so an empty allowlist rejects ALL s3 sources (fail
   * closed) to prevent a caller from reading arbitrary buckets (confused deputy).
   */
  s3AllowedBuckets?: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  urlMaxBytes?: number;
  /** Injectable clock for deterministic SigV4 in tests. */
  nowImpl?: () => Date;
}

interface TextractBlock {
  BlockType?: string;
  Text?: string;
}
interface DetectResponse {
  DocumentMetadata?: { Pages?: number };
  Blocks?: TextractBlock[];
  __type?: string;
  message?: string;
  Message?: string;
}

function parseS3Uri(uri: string): { Bucket: string; Name: string } {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) throw new DocumentClientError("invalid s3 uri (expected s3://bucket/key)");
  return { Bucket: m[1]!, Name: m[2]! };
}

/**
 * Amazon Textract `DetectDocumentText` (synchronous). Signed with SigV4 (no AWS
 * SDK). A `base64`/`url` source is sent inline as `Document.Bytes` (a `url` is
 * gateway-fetched, SSRF-guarded); an `s3://bucket/key` source is passed as
 * `Document.S3Object` for Textract to pull. Text is the concatenation of `LINE`
 * blocks; page count comes from `DocumentMetadata.Pages`.
 *
 * Note: the sync API is single-page for images; multi-page async
 * (`StartDocumentTextDetection`) is a future addition.
 */
export function createTextractAdapter(opts: TextractAdapterOptions): DocumentProviderAdapter {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.nowImpl ?? (() => new Date());
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const region = opts.region;
  const host = `textract.${region}.amazonaws.com`;
  const target = "Textract.DetectDocumentText";
  const contentType = "application/x-amz-json-1.1";

  return {
    slug: "textract",
    supportedInputs: ["base64", "url", "s3"],
    perPageUsd: opts.perPageUsd,
    async extract(source: DocumentSource): Promise<DocumentResult> {
      let document: { S3Object: { Bucket: string; Name: string } } | { Bytes: string };
      if (source.kind === "s3") {
        const s3 = parseS3Uri(source.s3);
        const allowed = opts.s3AllowedBuckets ?? [];
        if (!allowed.includes(s3.Bucket)) {
          throw new DocumentClientError(
            allowed.length === 0
              ? "s3 document sources are disabled (set TEXTRACT_S3_ALLOWED_BUCKETS)"
              : `s3 bucket '${s3.Bucket}' is not in the allowlist (TEXTRACT_S3_ALLOWED_BUCKETS)`,
          );
        }
        document = { S3Object: s3 };
      } else {
        document = { Bytes: await sourceToBase64(source, doFetch, { timeoutMs, maxBytes: opts.urlMaxBytes }) };
      }
      const payload = JSON.stringify({ Document: document });

      const signed = signAwsV4({
        method: "POST",
        host,
        path: "/",
        headers: { "content-type": contentType, "x-amz-target": target },
        payload,
        region,
        service: "textract",
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
        sessionToken: opts.sessionToken,
        now: now(),
      });

      let res: Response;
      try {
        res = await doFetch(`https://${host}/`, {
          method: "POST",
          headers: { "content-type": contentType, "x-amz-target": target, ...signed },
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new DocumentProviderError(`textract request failed: ${(err as Error).message}`, { cause: err });
      }

      if (!res.ok) {
        const body = await readJsonSafe<DetectResponse>(res);
        const detail = body.message ?? body.Message ?? body.__type ?? `HTTP ${res.status}`;
        // 4xx (bad document, access denied, invalid params) is a client error;
        // 5xx (and network) is a transient provider error.
        if (res.status >= 400 && res.status < 500) {
          throw new DocumentClientError(`textract rejected the document (${res.status}): ${detail}`);
        }
        throw new DocumentProviderError(`textract error ${res.status}: ${detail}`);
      }

      const body = await readJsonSafe<DetectResponse>(res);
      const text = (body.Blocks ?? [])
        .filter((b) => b.BlockType === "LINE" && typeof b.Text === "string")
        .map((b) => b.Text)
        .join("\n");
      return {
        text,
        pages: Math.max(1, Math.floor(body.DocumentMetadata?.Pages ?? 1)),
        model: "textract/detect-document-text",
        raw: body,
      };
    },
  };
}
