import { parseConfigObject } from "@modelgov/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import {
  ProviderError,
  type LiteLLMClient,
  type LiteLLMEmbeddingParams,
} from "../src/services/litellm";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";

const DATABASE_URL = process.env.DATABASE_URL;

const RAW_CONFIG = {
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
    by_user_type: {
      workflow: { daily_usd: 1, daily_requests: 100, models: ["embed"] },
      // Permits chat models only — the embed feature's class is not allowed.
      chatonly: { daily_usd: 1, daily_requests: 100, models: ["cheap"] },
      // Zero request budget — trips the daily request limit immediately.
      blocked: { daily_usd: 1, daily_requests: 0, models: ["embed"] },
    },
  },
  features: {
    kb_embedding: { model_class: "embed", max_tokens: 1 },
    // Restricted data: only the openai provider is approved (fallback is ollama).
    restricted_embed: { model_class: "embed", max_tokens: 1, data_sensitivity: "restricted" },
  },
  model_classes: {
    embed: { primary: "openai/text-embedding-3-small", fallback: "ollama/nomic-embed-text" },
    cheap: { primary: "openai/gpt-4o-mini" },
  },
  data_classes: {
    restricted: { allowed_providers: ["openai"] },
  },
  pricing: {
    "openai/text-embedding-3-small": { input_per_1k: 0.00002, output_per_1k: 0 },
  },
  safety: { preset: "dev" },
};

const config = parseConfigObject(RAW_CONFIG);

/** A fake embeddings client: one 3-dim vector per input, tiny fixed cost. */
function fakeEmbedClient(
  embed: (p: LiteLLMEmbeddingParams) => ReturnType<NonNullable<LiteLLMClient["embed"]>>,
): LiteLLMClient {
  return {
    chat: async () => {
      throw new Error("chat not used in embeddings tests");
    },
    embed,
  };
}

const okEmbed = fakeEmbedClient(async (p) => ({
  embeddings: p.input.map(() => [0.1, 0.2, 0.3]),
  model: p.model,
  actualCostUsd: 0.00001,
  inputTokens: 8,
  raw: {},
}));

describe.skipIf(!DATABASE_URL)("POST /v1/embeddings (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE budget_counters, request_logs, idempotency_keys");
  });

  function appWith(litellm: LiteLLMClient): FastifyInstance {
    return buildServer({
      config,
      pool,
      litellm,
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      allowUnauthenticated: true,
    });
  }

  const post = (app: FastifyInstance, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/v1/embeddings", payload: body });

  it("embeds inputs, records spend, and returns one vector per input", async () => {
    const app = appWith(okEmbed);
    const res = await post(app, {
      userId: "svc1",
      userType: "workflow",
      feature: "kb_embedding",
      input: ["how do I reset my password", "where is my invoice"],
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.embeddings).toHaveLength(2);
    expect(json.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
    expect(json.model).toBe("openai/text-embedding-3-small");
    expect(json.provider).toBe("openai");
    expect(json.decision).toBe("allow");
    expect(json.cost.actualUsd).toBeCloseTo(0.00001, 6);
    expect(json.requestId).toEqual(expect.any(String));

    const snap = await pool.query(
      "SELECT used_usd FROM budget_counters WHERE scope='user_daily' AND key='svc1'",
    );
    expect(Number(snap.rows[0].used_usd)).toBeCloseTo(0.00001, 6);

    const logged = await pool.query(
      "SELECT feature, status, decision FROM request_logs WHERE user_id='svc1'",
    );
    expect(logged.rows[0]).toMatchObject({ feature: "kb_embedding", status: "ok", decision: "allow" });
  });

  it("accepts a single string input", async () => {
    const app = appWith(okEmbed);
    const res = await post(app, {
      userId: "svc1",
      userType: "workflow",
      feature: "kb_embedding",
      input: "single query",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().embeddings).toHaveLength(1);
  });

  it("returns 400 for an unknown feature", async () => {
    const app = appWith(okEmbed);
    const res = await post(app, {
      userId: "svc1",
      userType: "workflow",
      feature: "ghost",
      input: ["x"],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("unknown_feature");
  });

  it("returns 403 policy_blocked when the feature's model class is not permitted", async () => {
    const app = appWith(okEmbed);
    const res = await post(app, {
      userId: "u1",
      userType: "chatonly",
      feature: "kb_embedding",
      input: ["x"],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("policy_blocked");
  });

  it("returns 403 when the daily request limit is exhausted", async () => {
    const app = appWith(okEmbed);
    const res = await post(app, {
      userId: "u2",
      userType: "blocked",
      feature: "kb_embedding",
      input: ["x"],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("policy_blocked");
  });

  it("falls back to the secondary model on a provider failure", async () => {
    let calls = 0;
    const flakyPrimary = fakeEmbedClient(async (p) => {
      calls += 1;
      if (p.model === "openai/text-embedding-3-small") {
        throw new ProviderError("primary down", 503);
      }
      return { embeddings: p.input.map(() => [1, 1]), model: p.model, actualCostUsd: 0, inputTokens: 3, raw: {} };
    });
    const app = appWith(flakyPrimary);
    const res = await post(app, {
      userId: "svc1",
      userType: "workflow",
      feature: "kb_embedding",
      input: ["x"],
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.model).toBe("ollama/nomic-embed-text");
    expect(json.provider).toBe("ollama");
    expect(json.decision).toBe("fallback");
    expect(calls).toBe(2);
  });

  it("blocks fallback to an unapproved provider for a data-sensitivity-gated feature", async () => {
    // Primary (openai) is approved and fails; the fallback (ollama) is NOT approved
    // for the 'restricted' data class, so the fallback must be blocked, not run.
    let fallbackRan = false;
    const flakyPrimary = fakeEmbedClient(async (p) => {
      if (p.model === "openai/text-embedding-3-small") {
        throw new ProviderError("primary down", 503);
      }
      fallbackRan = true;
      return { embeddings: p.input.map(() => [1, 1]), model: p.model, actualCostUsd: 0, inputTokens: 3, raw: {} };
    });
    const app = appWith(flakyPrimary);
    const res = await post(app, {
      userId: "svc1",
      userType: "workflow",
      feature: "restricted_embed",
      input: ["sensitive record"],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("policy_blocked");
    expect(fallbackRan).toBe(false);
  });

  it("returns 501 when the deployment's client has no embed support", async () => {
    const chatOnly: LiteLLMClient = { chat: async () => { throw new Error("unused"); } };
    const app = appWith(chatOnly);
    const res = await post(app, {
      userId: "svc1",
      userType: "workflow",
      feature: "kb_embedding",
      input: ["x"],
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe("not_implemented");
  });
});
