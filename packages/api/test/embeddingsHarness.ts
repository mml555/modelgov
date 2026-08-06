/**
 * Shared fixtures for the /v1/embeddings integration suites.
 *
 * Split out when embeddings.integration.test.ts outgrew the 650-LOC hard limit:
 * the config, the fake provider client, and the app/pool setup are identical
 * across the suites, and duplicating them would let the two files drift into
 * testing subtly different gateways.
 */
import { parseConfigObject } from "@modelgov/policy-engine";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import type { LiteLLMClient, LiteLLMEmbeddingParams } from "../src/services/litellm";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard, type SafetyGuard } from "../src/services/safety";
import { buildServer } from "../src/server";

export const DATABASE_URL = process.env.DATABASE_URL;

export const RAW_CONFIG = {
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

export const config = parseConfigObject(RAW_CONFIG);

/** A fake embeddings client: the caller decides the vectors, cost, and failures. */
export function fakeEmbedClient(
  embed: (p: LiteLLMEmbeddingParams) => ReturnType<NonNullable<LiteLLMClient["embed"]>>,
): LiteLLMClient {
  return {
    chat: async () => {
      throw new Error("chat not used in embeddings tests");
    },
    embed,
  };
}

/** The default happy path: one 3-dim vector per input, tiny fixed cost. */
export const okEmbed = fakeEmbedClient(async (p) => ({
  embeddings: p.input.map(() => [0.1, 0.2, 0.3]),
  model: p.model,
  actualCostUsd: 0.00001,
  inputTokens: 8,
  raw: {},
}));

export interface EmbeddingsHarness {
  /** The live pool — only needed by suites that assert on rows directly. */
  pool: () => Pool;
  appWith: (litellm: LiteLLMClient) => FastifyInstance;
  appWithSafety: (litellm: LiteLLMClient, safety: SafetyGuard) => FastifyInstance;
  post: (app: FastifyInstance, body: Record<string, unknown>) => Promise<LightMyRequestResponse>;
}

/**
 * Registers the pool lifecycle and per-test TRUNCATE, and returns the app
 * builders. Call inside a `describe` — it installs vitest hooks.
 */
export function setupEmbeddings(): EmbeddingsHarness {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query(
      `TRUNCATE budget_counters, request_logs, idempotency_keys,
       billing_accounts, billing_reservation_leases, meter_events`,
    );
  });

  return {
    pool: () => pool,
    appWith: (litellm) =>
      buildServer({
        config,
        pool,
        litellm,
        safety: new NoopGuard(),
        observability: new NoopObservability(),
        logger: false,
        allowUnauthenticated: true,
      }),
    appWithSafety: (litellm, safety) =>
      buildServer({
        config,
        pool,
        litellm,
        safety,
        observability: new NoopObservability(),
        logger: false,
        allowUnauthenticated: true,
      }),
    post: (app, body) => app.inject({ method: "POST", url: "/v1/embeddings", payload: body }),
  };
}
