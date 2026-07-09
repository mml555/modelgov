import { createHash, createHmac } from "node:crypto";

// Dependency-free AWS Signature Version 4 signer. The gateway calls a small
// number of AWS JSON APIs directly (Textract today), so rather than pull in the
// AWS SDK we sign requests here. Kept general (method/path/query/headers/payload)
// and clock-injectable so it can be unit-tested deterministically. Live AWS
// validation requires real credentials (staging).

export interface SigV4Params {
  method: string;
  host: string;
  /** Canonical URI (already URI-encoded); "/" for a service-root JSON POST. */
  path: string;
  /** Canonical (sorted) query string; "" for none. */
  query?: string;
  /** Headers to sign in addition to host/x-amz-date (e.g. content-type, x-amz-target). */
  headers: Record<string, string>;
  payload: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now: Date;
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** ISO 8601 basic format, e.g. 20150830T123600Z. */
function toAmzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Compute the SigV4 headers to attach to a request: `Authorization`, `X-Amz-Date`,
 * and (when a session token is present) `X-Amz-Security-Token`. The caller sends
 * these alongside the same `headers` that were passed in.
 */
export function signAwsV4(params: SigV4Params): Record<string, string> {
  const amzDate = toAmzDate(params.now);
  const dateStamp = amzDate.slice(0, 8);

  // Build the canonical, signed header set: caller headers + host + x-amz-date
  // (+ security token). Names lowercased, values trimmed, sorted by name.
  const headerMap: Record<string, string> = {};
  // SigV4 canonicalization: lowercase the name, trim, AND collapse sequential
  // internal whitespace to a single space (a value with double spaces would
  // otherwise sign differently than AWS recomputes → SignatureDoesNotMatch).
  for (const [k, v] of Object.entries(params.headers)) {
    headerMap[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  }
  headerMap.host = params.host;
  headerMap["x-amz-date"] = amzDate;
  if (params.sessionToken) headerMap["x-amz-security-token"] = params.sessionToken;

  const sortedNames = Object.keys(headerMap).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${headerMap[n]}\n`).join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [
    params.method,
    params.path,
    params.query ?? "",
    canonicalHeaders,
    signedHeaders,
    sha256Hex(params.payload),
  ].join("\n");

  const credentialScope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${params.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, params.region);
  const kService = hmac(kRegion, params.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const out: Record<string, string> = { Authorization: authorization, "X-Amz-Date": amzDate };
  if (params.sessionToken) out["X-Amz-Security-Token"] = params.sessionToken;
  return out;
}
