import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/services/litellm";
import {
  DATABASE_URL,
  fakeEmbedClient,
  okEmbed,
  setupEmbeddings,
} from "./embeddingsHarness";

// Vector width defines the vector space. A corpus embedded at one width cannot
// be compared against another, so `dimensions` has to reach the provider
// unchanged and the response has to report what actually came back — never an
// echo of the request. Split from embeddings.integration.test.ts to stay under
// the file-size limit; the harness is shared so the two cannot drift.
describe.skipIf(!DATABASE_URL)("POST /v1/embeddings — dimensions", () => {
  const { appWith, post } = setupEmbeddings();

  it("forwards dimensions to the provider and echoes the width actually returned", async () => {
    // Vector width defines the vector space: a corpus embedded at a different
    // width cannot be compared against this one, so the caller has to be able
    // to assert what it got rather than trust the model's default.
    let seen: number | undefined;
    const client = fakeEmbedClient(async (p) => {
      seen = p.dimensions;
      return {
        embeddings: p.input.map(() => Array.from({ length: p.dimensions ?? 3 }, () => 0.1)),
        model: p.model,
        actualCostUsd: 0.00001,
        inputTokens: 8,
        raw: {},
      };
    });
    const res = await post(appWith(client), {
      userId: "svc-dim",
      userType: "workflow",
      feature: "kb_embedding",
      input: ["chunk"],
      dimensions: 512,
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toBe(512);
    expect(res.json().dimensions).toBe(512);
    expect(res.json().embeddings[0]).toHaveLength(512);
  });

  it("omits dimensions from the provider call when unset, and still reports the width", async () => {
    // Absent, not null — a non-MRL provider must see the request it always saw.
    let sawKey = true;
    const client = fakeEmbedClient(async (p) => {
      sawKey = "dimensions" in p && p.dimensions !== undefined;
      return { embeddings: [[0.1, 0.2, 0.3]], model: p.model, actualCostUsd: 0.00001, inputTokens: 8, raw: {} };
    });
    const res = await post(appWith(client), {
      userId: "svc-dim2",
      userType: "workflow",
      feature: "kb_embedding",
      input: ["chunk"],
    });
    expect(res.statusCode).toBe(200);
    expect(sawKey).toBe(false);
    // Reported regardless, read off the returned vector.
    expect(res.json().dimensions).toBe(3);
  });

  it("reports the ACTUAL width when a provider ignores the requested dimensions", async () => {
    // Some providers silently ignore `dimensions` on non-MRL models. Echoing
    // the request back would tell the caller a comfortable lie; the response
    // must reflect the vector they actually received.
    const client = fakeEmbedClient(async (p) => ({
      embeddings: [[0.1, 0.2, 0.3, 0.4]], // full width, request ignored
      model: p.model,
      actualCostUsd: 0.00001,
      inputTokens: 8,
      raw: {},
    }));
    const res = await post(appWith(client), {
      userId: "svc-dim3",
      userType: "workflow",
      feature: "kb_embedding",
      input: ["chunk"],
      dimensions: 512,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dimensions).toBe(4);
  });

  it("forwards dimensions on the FALLBACK provider call too", async () => {
    // The retry is a second, separate embed() call. Threading `dimensions` into
    // only the primary would silently change the vector space when a provider
    // hiccup routes a request to the fallback — corrupting a shared index.
    const seen: Array<number | undefined> = [];
    const flakyPrimary = fakeEmbedClient(async (p) => {
      seen.push(p.dimensions);
      if (seen.length === 1) throw new ProviderError("primary down", 503);
      return { embeddings: p.input.map(() => [1, 1]), model: p.model, actualCostUsd: 0, inputTokens: 3, raw: {} };
    });
    const res = await post(appWith(flakyPrimary), {
      userId: "svc1",
      userType: "workflow",
      feature: "kb_embedding",
      input: ["x"],
      dimensions: 512,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision).toBe("fallback");
    expect(seen).toEqual([512, 512]);
  });

  it("reports null when a batch comes back with mixed vector widths", async () => {
    // A provider that does this is malfunctioning and the batch is unusable in
    // a vector store. Reporting the first row's width would be a false claim
    // about the rest, so the gateway says "unknown" instead.
    const client = fakeEmbedClient(async (p) => ({
      embeddings: [[0.1, 0.2], [0.1, 0.2, 0.3]],
      model: p.model,
      actualCostUsd: 0.00001,
      inputTokens: 8,
      raw: {},
    }));
    const res = await post(appWith(client), {
      userId: "svc-mixed",
      userType: "workflow",
      feature: "kb_embedding",
      input: ["a", "b"],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dimensions).toBeNull();
  });

  it("accepts the documented maximum and rejects one above it", async () => {
    const app = appWith(okEmbed);
    const body = (dimensions: number) => ({
      userId: "svc-bound",
      userType: "workflow",
      feature: "kb_embedding",
      input: ["chunk"],
      dimensions,
    });
    // The bound is documented, so pin both sides of it.
    expect((await post(app, body(16_384))).statusCode).toBe(200);
    expect((await post(app, body(16_385))).statusCode).toBe(400);
  });

  it("rejects a non-positive or absurd dimensions value", async () => {
    const app = appWith(okEmbed);
    for (const dimensions of [0, -1, 1.5, 999_999]) {
      const res = await post(app, {
        userId: "svc-dim4",
        userType: "workflow",
        feature: "kb_embedding",
        input: ["chunk"],
        dimensions,
      });
      expect(res.statusCode, `dimensions=${dimensions}`).toBe(400);
    }
  });
});
