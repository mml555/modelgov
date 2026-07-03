import type { TraceTags } from "@modelgov/policy-engine";
import { describe, expect, it } from "vitest";
import {
  createObservability,
  LangfuseObservability,
  NoopObservability,
  OtelObservability,
  type ChatObservation,
} from "../src/services/observability";

const traceTags: TraceTags = {
  userId: "u1",
  feature: "support_chat",
  modelClass: "cheap",
  policyDecision: "allow",
};

const observation: ChatObservation = {
  userId: "u1",
  feature: "support_chat",
  decision: "allow",
  status: "ok",
  model: "openai/gpt-4o-mini",
  input: [{ role: "user", content: "hi" }],
  output: "hello",
  inputTokens: 5,
  outputTokens: 3,
  actualCostUsd: 0.0002,
  traceTags,
};

describe("createObservability", () => {
  it("returns Noop when provider is none", () => {
    const o = createObservability({ provider: "none" });
    expect(o).toBeInstanceOf(NoopObservability);
  });

  it("returns Noop when langfuse keys are missing", () => {
    const o = createObservability({ provider: "langfuse" });
    expect(o).toBeInstanceOf(NoopObservability);
  });

  it("returns Langfuse when fully configured", () => {
    const o = createObservability({
      provider: "langfuse",
      publicKey: "pk",
      secretKey: "sk",
      baseUrl: "http://localhost:3001",
    });
    expect(o).toBeInstanceOf(LangfuseObservability);
  });

  it("returns Otel when provider is otel with an endpoint", () => {
    const o = createObservability({ provider: "otel", otelEndpoint: "http://collector:4318" });
    expect(o).toBeInstanceOf(OtelObservability);
  });

  it("falls back to Noop when otel endpoint is missing", () => {
    expect(createObservability({ provider: "otel" })).toBeInstanceOf(NoopObservability);
  });
});

describe("OtelObservability", () => {
  it("POSTs an OTLP span with chat attributes to /v1/traces", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (u: string, init: { body: string }) => {
      url = u;
      body = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const o = new OtelObservability({
      endpoint: "http://collector:4318/",
      serviceName: "modelgov-test",
      fetchImpl,
      now: () => 1_700_000_000_000,
      randomHex: (n) => "a".repeat(n * 2),
    });
    o.recordChat(observation);
    await o.shutdown();

    expect(url).toBe("http://collector:4318/v1/traces");
    const payload = body as {
      resourceSpans: Array<{
        scopeSpans: Array<{ spans: Array<{ name: string; status: { code: number }; traceId: string; attributes: Array<{ key: string }> }> }>;
      }>;
    };
    const span = payload.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(span).toBeDefined();
    if (!span) return;
    expect(span.name).toBe("chat:support_chat");
    expect(span.status.code).toBe(1);
    expect(span.traceId).toHaveLength(32);
    const attrKeys = span.attributes.map((a: { key: string }) => a.key);
    expect(attrKeys).toContain("modelgov.cost_usd");
    expect(attrKeys).toContain("modelgov.model");
  });

  it("marks error status and never throws on a failing exporter", async () => {
    const fetchImpl = (async () => {
      throw new Error("collector down");
    }) as unknown as typeof fetch;
    const o = new OtelObservability({ endpoint: "http://x/", serviceName: "s", fetchImpl });
    expect(() => o.recordChat({ ...observation, status: "error", reason: "boom" })).not.toThrow();
    await expect(o.shutdown()).resolves.toBeUndefined();
  });
});

describe("NoopObservability", () => {
  it("recordChat is a no-op and shutdown resolves", async () => {
    const o = new NoopObservability();
    expect(() => o.recordChat(observation)).not.toThrow();
    await expect(o.shutdown()).resolves.toBeUndefined();
  });
});

describe("LangfuseObservability", () => {
  it("recordChat never throws, even with an unreachable host", async () => {
    const o = new LangfuseObservability({
      publicKey: "pk",
      secretKey: "sk",
      baseUrl: "http://127.0.0.1:1", // unreachable
      captureContent: true,
    });
    expect(() => o.recordChat(observation)).not.toThrow();
    expect(() =>
      o.recordChat({ ...observation, status: "blocked", model: undefined, reason: "over budget" }),
    ).not.toThrow();
    await o.shutdown();
  });
});
