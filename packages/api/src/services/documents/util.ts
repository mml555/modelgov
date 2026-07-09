import { lookup as dnsLookup } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent } from "undici";
import { assertPublicHttpUrl, isPrivateHttpHost } from "../../util/httpUrlGuard";
import { DocumentClientError, DocumentProviderError, type DocumentSource } from "./types";

/** Cap on a gateway-fetched document (`url` source) — inline base64 is already
 *  bounded by the request body limit; a fetched URL is not, so bound it here. */
export const DEFAULT_URL_MAX_BYTES = 25 * 1024 * 1024;

/** Read a response body as text, tolerating a broken/empty body (error paths). */
export async function readTextSafe(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Parse a response body as JSON, tolerating a non-JSON/empty body. */
export async function readJsonSafe<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    return {} as T;
  }
}

/**
 * Syntactic gate for a caller-supplied document URL: must be https and not a
 * literal private/link-local host. This is the fast preflight; the AUTHORITATIVE
 * anti-SSRF check happens at connect time in {@link ssrfGuardedLookup}.
 */
export function assertFetchableDocumentUrl(rawUrl: string): URL {
  let target: URL;
  try {
    target = assertPublicHttpUrl(rawUrl);
  } catch (err) {
    throw new DocumentClientError((err as Error).message);
  }
  if (target.protocol !== "https:") {
    throw new DocumentClientError("document url must be https");
  }
  return target;
}

/**
 * A net.connect-style lookup that rejects any resolved private/link-local
 * address AT CONNECT TIME. Because undici uses this exact lookup for the socket
 * it opens, the address validated is the address connected to — closing the
 * DNS-rebinding TOCTOU that a preflight-only resolve leaves open (a rebinding
 * host can answer the preflight with a public IP and the real fetch with a
 * private one). Exported for direct testing.
 */
export const ssrfGuardedLookup: LookupFunction = (hostname, options, callback) => {
  // Force `all` so single- and multi-address results validate uniformly; net's
  // connect path requests one address, so we answer with the first validated one.
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, "", 0);
      return;
    }
    const bad = addresses.find((a) => isPrivateHttpHost(a.address));
    if (bad) {
      const blocked: NodeJS.ErrnoException = new Error(
        `refusing to connect to private address ${bad.address} for '${hostname}' (SSRF guard)`,
      );
      blocked.code = "ESSRFBLOCKED";
      callback(blocked, "", 0);
      return;
    }
    const first = addresses[0];
    if (!first) {
      callback(new Error(`no address for '${hostname}'`) as NodeJS.ErrnoException, "", 0);
      return;
    }
    callback(null, first.address, first.family);
  });
};

/**
 * Dispatcher used for every gateway-side document fetch. Its connect-time lookup
 * ({@link ssrfGuardedLookup}) is the real SSRF boundary — validating the address
 * the socket actually connects to, not a re-resolvable preflight.
 */
const documentFetchAgent = new Agent({ connect: { lookup: ssrfGuardedLookup } });

/**
 * Resolve a document source to raw base64 for adapters that must send bytes
 * (Tesseract, Textract inline). `base64` passes through; `url` is https-checked,
 * fetched through the SSRF-guarded dispatcher (connect-time private-address
 * rejection + no redirect following) and streamed with an incremental size cap;
 * `s3` cannot be materialized here (only a provider that pulls it — Textract —
 * supports it) and is rejected.
 */
export async function sourceToBase64(
  source: DocumentSource,
  fetchImpl: typeof fetch,
  opts: { timeoutMs: number; maxBytes?: number },
): Promise<string> {
  if (source.kind === "base64") return source.base64;
  if (source.kind === "s3") {
    throw new DocumentClientError("this provider cannot fetch an s3 source; supply base64 or a url");
  }
  const target = assertFetchableDocumentUrl(source.url);
  const maxBytes = opts.maxBytes ?? DEFAULT_URL_MAX_BYTES;

  let res: Response;
  try {
    // redirect:"manual" — never follow a 3xx to a fresh (unvalidated) host; the
    // dispatcher validates the connect address so a rebinding host can't SSRF.
    res = await fetchImpl(target.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs),
      dispatcher: documentFetchAgent,
    } as RequestInit & { dispatcher: Agent });
  } catch (err) {
    throw new DocumentProviderError(`failed to fetch document url: ${(err as Error).message}`, { cause: err });
  }
  if (res.status >= 300 && res.status < 400) {
    throw new DocumentClientError("document url returned a redirect; redirects are not followed (SSRF guard)");
  }
  if (!res.ok) {
    throw new DocumentClientError(`document url returned ${res.status}`);
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared && declared > maxBytes) {
    throw new DocumentClientError(`document exceeds ${maxBytes} bytes`);
  }

  // Stream with a running byte cap so a chunked / undeclared-length body can't be
  // buffered whole into memory before the size check.
  const body = res.body;
  if (!body) throw new DocumentProviderError("document url returned no body");
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new DocumentClientError(`document exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    // Preserve the size-cap client error; classify a mid-stream abort/timeout/
    // connection drop as a (retryable) provider error rather than letting a raw
    // error escape unclassified.
    if (err instanceof DocumentClientError) throw err;
    throw new DocumentProviderError(`document url stream failed: ${(err as Error).message}`, { cause: err });
  }
  return Buffer.concat(chunks).toString("base64");
}
