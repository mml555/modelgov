import { describe, expect, it } from "vitest";
import {
  createAzureDiAdapter,
  createDocumentClient,
  createTesseractAdapter,
  createTextractAdapter,
  DocumentClientError,
  DocumentProviderError,
  signAwsV4,
  ssrfGuardedLookup,
  type SigV4Params,
} from "../src/services/documents";

describe("ssrfGuardedLookup (connect-time SSRF guard)", () => {
  const run = (host: string) =>
    new Promise<NodeJS.ErrnoException | null>((resolve) => {
      ssrfGuardedLookup(host, {}, (err) => resolve(err));
    });

  it("rejects a resolved private/link-local address", async () => {
    // Numeric literals resolve locally (no network) to themselves.
    expect(String(await run("10.0.0.1"))).toMatch(/private|SSRF/i);
    expect(String(await run("169.254.169.254"))).toMatch(/private|SSRF/i);
  });

  it("allows a resolved public address", async () => {
    expect(await run("93.184.216.34")).toBeNull();
  });
});

describe("document client registry", () => {
  it("registers only configured providers and resolves their adapters", () => {
    const client = createDocumentClient({
      tesseract: { url: "http://tess:8080", perPageUsd: 0 },
      azureDi: { endpoint: "https://di", key: "k", perPageUsd: 0.0015 },
      textract: { region: "us-east-1", accessKeyId: "AKID", secretAccessKey: "S", perPageUsd: 0.0015 },
    });
    expect(client.providers().sort()).toEqual(["azure-di", "tesseract", "textract"]);
    expect(client.get("tesseract")?.slug).toBe("tesseract");
    expect(client.get("azure-di")?.perPageUsd).toBe(0.0015);
    expect(client.get("textract")?.supportedInputs).toContain("s3");
    expect(client.get("nope")).toBeUndefined();
  });

  it("omits unconfigured providers", () => {
    const client = createDocumentClient({ tesseract: { url: "http://tess", perPageUsd: 0 } });
    expect(client.providers()).toEqual(["tesseract"]);
    expect(client.get("azure-di")).toBeUndefined();
    expect(client.get("textract")).toBeUndefined();
  });
});

// Unit tests for the two document-AI adapters against a mocked fetch — no network,
// no credentials. Live use is exercised manually / in staging with real endpoints.

describe("tesseract adapter", () => {
  it("posts base64 to the sidecar and returns text + pages", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return new Response(JSON.stringify({ text: "extracted", pages: 4 }), { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = createTesseractAdapter({ url: "http://tess:8080/", perPageUsd: 0, fetchImpl });
    const res = await adapter.extract({ kind: "base64", base64: "ZmFrZQ==" });
    expect(res).toMatchObject({ text: "extracted", pages: 4, model: "tesseract" });
    expect(calls[0]!.url).toBe("http://tess:8080/extract");
    expect(calls[0]!.body).toEqual({ base64: "ZmFrZQ==" });
  });

  it("fetches an https url (SSRF-guarded) then posts its bytes", async () => {
    // A public IP literal so the SSRF DNS check resolves locally (no network).
    const docUrl = "https://93.184.216.34/doc.pdf";
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      if (url === docUrl) {
        return new Response(Buffer.from("PDFBYTES"), { status: 200 });
      }
      return new Response(JSON.stringify({ text: "ok", pages: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = createTesseractAdapter({ url: "http://tess:8080", perPageUsd: 0, fetchImpl });
    const res = await adapter.extract({ kind: "url", url: docUrl });
    expect(res.pages).toBe(1);
    expect(seen).toEqual([docUrl, "http://tess:8080/extract"]);
  });

  it("rejects a private-host url (SSRF guard) as a client error", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 200 })) as unknown as typeof fetch;
    const adapter = createTesseractAdapter({ url: "http://tess:8080", perPageUsd: 0, fetchImpl });
    await expect(adapter.extract({ kind: "url", url: "http://169.254.169.254/latest" })).rejects.toBeInstanceOf(
      DocumentClientError,
    );
  });

  it("refuses to follow a redirect on a url source (SSRF guard)", async () => {
    // redirect:'manual' means fetch returns the 3xx rather than following it.
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })) as unknown as typeof fetch;
    const adapter = createTesseractAdapter({ url: "http://tess:8080", perPageUsd: 0, fetchImpl });
    await expect(adapter.extract({ kind: "url", url: "https://93.184.216.34/doc.pdf" })).rejects.toBeInstanceOf(
      DocumentClientError,
    );
  });

  it("maps 4xx to client error and 5xx to provider error", async () => {
    const make = (status: number) =>
      createTesseractAdapter({
        url: "http://tess:8080",
        perPageUsd: 0,
        fetchImpl: (async () => new Response("bad", { status })) as unknown as typeof fetch,
      });
    await expect(make(400).extract({ kind: "base64", base64: "eA==" })).rejects.toBeInstanceOf(DocumentClientError);
    await expect(make(503).extract({ kind: "base64", base64: "eA==" })).rejects.toBeInstanceOf(DocumentProviderError);
  });

  it("maps a network error to a provider error", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const adapter = createTesseractAdapter({ url: "http://tess:8080", perPageUsd: 0, fetchImpl });
    await expect(adapter.extract({ kind: "base64", base64: "eA==" })).rejects.toBeInstanceOf(DocumentProviderError);
  });
});

describe("azure-di adapter", () => {
  const noSleep = async () => {};

  it("submits, polls to success, and returns content + page count", async () => {
    let call = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        expect(init?.method).toBe("POST");
        return new Response(null, {
          status: 202,
          headers: { "operation-location": "https://di/op/123" },
        });
      }
      // poll
      return new Response(
        JSON.stringify({ status: "succeeded", analyzeResult: { content: "page text", pages: [{}, {}, {}] } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const adapter = createAzureDiAdapter({
      endpoint: "https://di.cognitiveservices.azure.com",
      key: "k",
      perPageUsd: 0.0015,
      fetchImpl,
      sleepImpl: noSleep,
    });
    const res = await adapter.extract({ kind: "base64", base64: "ZmFrZQ==" });
    expect(res.text).toBe("page text");
    expect(res.pages).toBe(3);
    expect(res.model).toBe("azure-di/prebuilt-read");
  });

  it("passes a url as urlSource", async () => {
    let submitBody: unknown;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        submitBody = JSON.parse(init.body as string);
        return new Response(null, { status: 202, headers: { "operation-location": "https://di/op/1" } });
      }
      return new Response(JSON.stringify({ status: "succeeded", analyzeResult: { content: "x", pages: [{}] } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const adapter = createAzureDiAdapter({ endpoint: "https://di", key: "k", perPageUsd: 0.0015, fetchImpl, sleepImpl: noSleep });
    await adapter.extract({ kind: "url", url: "https://blob/doc.pdf" });
    expect(submitBody).toEqual({ urlSource: "https://blob/doc.pdf" });
  });

  it("throws a provider error when analysis fails", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return new Response(null, { status: 202, headers: { "operation-location": "https://di/op/2" } });
      return new Response(JSON.stringify({ status: "failed", error: { message: "corrupt document" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createAzureDiAdapter({ endpoint: "https://di", key: "k", perPageUsd: 0.0015, fetchImpl, sleepImpl: noSleep });
    await expect(adapter.extract({ kind: "base64", base64: "eA==" })).rejects.toBeInstanceOf(DocumentProviderError);
  });

  it("maps a 4xx submit to a client error", async () => {
    const fetchImpl = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    const adapter = createAzureDiAdapter({ endpoint: "https://di", key: "k", perPageUsd: 0.0015, fetchImpl, sleepImpl: noSleep });
    await expect(adapter.extract({ kind: "base64", base64: "eA==" })).rejects.toBeInstanceOf(DocumentClientError);
  });

  it("maps a 5xx submit to a provider error", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const adapter = createAzureDiAdapter({ endpoint: "https://di", key: "k", perPageUsd: 0.0015, fetchImpl, sleepImpl: noSleep });
    await expect(adapter.extract({ kind: "base64", base64: "eA==" })).rejects.toBeInstanceOf(DocumentProviderError);
  });

  it("errors when the submit returns no operation-location", async () => {
    const fetchImpl = (async () => new Response(null, { status: 202 })) as unknown as typeof fetch;
    const adapter = createAzureDiAdapter({ endpoint: "https://di", key: "k", perPageUsd: 0.0015, fetchImpl, sleepImpl: noSleep });
    await expect(adapter.extract({ kind: "base64", base64: "eA==" })).rejects.toBeInstanceOf(DocumentProviderError);
  });

  it("polls through a 'running' status before succeeding", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return new Response(null, { status: 202, headers: { "operation-location": "https://di/op" } });
      if (call === 2) return new Response(JSON.stringify({ status: "running" }), { status: 200 });
      return new Response(JSON.stringify({ status: "succeeded", analyzeResult: { content: "done", pages: [{}] } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const adapter = createAzureDiAdapter({ endpoint: "https://di", key: "k", perPageUsd: 0.0015, fetchImpl, sleepImpl: noSleep });
    const res = await adapter.extract({ kind: "base64", base64: "eA==" });
    expect(res.text).toBe("done");
    expect(res.pages).toBe(1);
  });

  it("maps a 4xx during poll to a client error", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return new Response(null, { status: 202, headers: { "operation-location": "https://di/op" } });
      return new Response("expired", { status: 404 });
    }) as unknown as typeof fetch;
    const adapter = createAzureDiAdapter({ endpoint: "https://di", key: "k", perPageUsd: 0.0015, fetchImpl, sleepImpl: noSleep });
    await expect(adapter.extract({ kind: "base64", base64: "eA==" })).rejects.toBeInstanceOf(DocumentClientError);
  });

  it("uses the default poll delay when no sleepImpl is injected", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return new Response(null, { status: 202, headers: { "operation-location": "https://di/op" } });
      return new Response(JSON.stringify({ status: "succeeded", analyzeResult: { content: "x", pages: [{}] } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    // No sleepImpl → exercises the real setTimeout-based delay (tiny interval).
    const adapter = createAzureDiAdapter({ endpoint: "https://di", key: "k", perPageUsd: 0.0015, fetchImpl, pollIntervalMs: 1 });
    const res = await adapter.extract({ kind: "base64", base64: "eA==" });
    expect(res.pages).toBe(1);
  });
});

describe("sigv4 signer", () => {
  const base: SigV4Params = {
    method: "POST",
    host: "textract.us-east-1.amazonaws.com",
    path: "/",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "Textract.DetectDocumentText" },
    payload: JSON.stringify({ Document: { Bytes: "eA==" } }),
    region: "us-east-1",
    service: "textract",
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
    now: new Date("2015-08-30T12:36:00Z"),
  };

  it("produces a well-formed Authorization header with sorted signed headers", () => {
    const h = signAwsV4(base);
    expect(h["X-Amz-Date"]).toBe("20150830T123600Z");
    expect(h.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/20150830\/us-east-1\/textract\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
  });

  it("is deterministic and sensitive to payload, time, and key", () => {
    const sig = signAwsV4(base).Authorization;
    expect(signAwsV4(base).Authorization).toBe(sig);
    expect(signAwsV4({ ...base, payload: `${base.payload} ` }).Authorization).not.toBe(sig);
    expect(signAwsV4({ ...base, now: new Date("2015-08-30T12:36:01Z") }).Authorization).not.toBe(sig);
    expect(signAwsV4({ ...base, secretAccessKey: "OTHER" }).Authorization).not.toBe(sig);
  });

  it("signs and sends the security token when present", () => {
    const h = signAwsV4({ ...base, sessionToken: "TOKEN" });
    expect(h["X-Amz-Security-Token"]).toBe("TOKEN");
    expect(h.Authorization).toContain("x-amz-security-token");
  });
});

describe("textract adapter", () => {
  const creds = {
    region: "us-east-1",
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
    perPageUsd: 0.0015,
    nowImpl: () => new Date("2020-01-01T00:00:00Z"),
  };

  it("sends Bytes for base64, signs the request, and joins LINE blocks", async () => {
    let captured: { url: string; headers: Record<string, string>; body: unknown } | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      captured = {
        url,
        headers: init?.headers as Record<string, string>,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      return new Response(
        JSON.stringify({
          DocumentMetadata: { Pages: 2 },
          Blocks: [
            { BlockType: "LINE", Text: "line one" },
            { BlockType: "WORD", Text: "ignored" },
            { BlockType: "LINE", Text: "line two" },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const adapter = createTextractAdapter({ ...creds, fetchImpl });
    const res = await adapter.extract({ kind: "base64", base64: "ZmFrZQ==" });
    expect(res.text).toBe("line one\nline two");
    expect(res.pages).toBe(2);
    expect(res.model).toBe("textract/detect-document-text");
    expect(captured!.url).toBe("https://textract.us-east-1.amazonaws.com/");
    expect(captured!.body).toEqual({ Document: { Bytes: "ZmFrZQ==" } });
    expect(captured!.headers.Authorization).toContain("AWS4-HMAC-SHA256");
    expect(captured!.headers["x-amz-target"]).toBe("Textract.DetectDocumentText");
  });

  it("passes an s3 source as S3Object without fetching bytes", async () => {
    let body: unknown;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(JSON.stringify({ DocumentMetadata: { Pages: 1 }, Blocks: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createTextractAdapter({ ...creds, s3AllowedBuckets: ["my-bucket"], fetchImpl });
    await adapter.extract({ kind: "s3", s3: "s3://my-bucket/scans/doc.pdf" });
    expect(body).toEqual({ Document: { S3Object: { Bucket: "my-bucket", Name: "scans/doc.pdf" } } });
  });

  it("rejects an s3 bucket not on the allowlist (confused-deputy guard)", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const adapter = createTextractAdapter({ ...creds, s3AllowedBuckets: ["allowed-bucket"], fetchImpl });
    await expect(adapter.extract({ kind: "s3", s3: "s3://internal-secrets/key" })).rejects.toBeInstanceOf(
      DocumentClientError,
    );
  });

  it("rejects all s3 sources when no allowlist is configured (fail closed)", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const adapter = createTextractAdapter({ ...creds, fetchImpl });
    await expect(adapter.extract({ kind: "s3", s3: "s3://any-bucket/key" })).rejects.toBeInstanceOf(
      DocumentClientError,
    );
  });

  it("rejects an invalid s3 uri as a client error", async () => {
    const adapter = createTextractAdapter({
      ...creds,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    await expect(adapter.extract({ kind: "s3", s3: "not-an-s3-uri" })).rejects.toBeInstanceOf(DocumentClientError);
  });

  it("maps 4xx to client error and 5xx to provider error", async () => {
    const make = (status: number) =>
      createTextractAdapter({
        ...creds,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ __type: "X", message: "boom" }), { status })) as unknown as typeof fetch,
      });
    await expect(make(400).extract({ kind: "base64", base64: "eA==" })).rejects.toBeInstanceOf(DocumentClientError);
    await expect(make(500).extract({ kind: "base64", base64: "eA==" })).rejects.toBeInstanceOf(DocumentProviderError);
  });
});
