import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { checkProviderHealth, checkReady } from "../src/modules/health/service";

describe("checkReady", () => {
  it("reports ready when database and mocked deps respond", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{ ok: 1 }], rowCount: 1 })),
    } as unknown as Pool;

    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith("/health")) {
        return new Response("ok", { status: 200 });
      }
      return new Response("fail", { status: 503 });
    });

    const ready = await checkReady({
      pool,
      litellmBaseUrl: "http://litellm:4000",
      presidioAnalyzerUrl: "http://presidio-analyzer:3000",
      presidioAnonymizerUrl: "http://presidio-anonymizer:3000",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(ready.status).toBe("ready");
    expect(ready.checks.database).toBe("ok");
    expect(ready.checks.litellm).toBe("ok");
    expect(ready.checks.presidio).toBe("ok");
  });

  it("skips optional deps when URLs are omitted", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{ ok: 1 }], rowCount: 1 })),
    } as unknown as Pool;

    const ready = await checkReady({ pool });
    expect(ready.status).toBe("ready");
    expect(ready.checks.litellm).toBe("skipped");
    expect(ready.checks.presidio).toBe("skipped");
  });
});

describe("checkProviderHealth", () => {
  const pool = { query: vi.fn() } as unknown as Pool;

  it("is skipped when no LiteLLM base URL is configured", async () => {
    expect(await checkProviderHealth({ pool })).toEqual({ status: "skipped", models: [] });
  });

  it("parses LiteLLM's per-model health body and derives provider + status", async () => {
    const body = {
      healthy_endpoints: [{ model: "openai/gpt-4o" }, { model: "bedrock/anthropic.claude-3-opus-20240229-v1:0" }],
      unhealthy_endpoints: [{ model: "azure/gpt-4o", error: "401 Unauthorized" }],
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const result = await checkProviderHealth({
      pool,
      litellmBaseUrl: "http://litellm:4000",
      litellmApiKey: "sk-x",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.status).toBe("degraded"); // one of three down
    expect(result.models).toContainEqual({ model: "openai/gpt-4o", provider: "openai", healthy: true });
    expect(result.models).toContainEqual({ model: "bedrock/anthropic.claude-3-opus-20240229-v1:0", provider: "bedrock", healthy: true });
    expect(result.models).toContainEqual({ model: "azure/gpt-4o", provider: "azure", healthy: false, error: "401 Unauthorized" });
  });

  it("reports fail when the proxy is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await checkProviderHealth({
      pool,
      litellmBaseUrl: "http://litellm:4000",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result).toEqual({ status: "fail", models: [] });
  });

  it("reports ok when every endpoint is healthy", async () => {
    const body = { healthy_endpoints: [{ model: "openai/gpt-4o" }], unhealthy_endpoints: [] };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const result = await checkProviderHealth({
      pool,
      litellmBaseUrl: "http://litellm:4000",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.status).toBe("ok");
  });
});
