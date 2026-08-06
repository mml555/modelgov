import { describe, expect, it } from "vitest";
import { ProviderError, type LiteLLMClient } from "../src/services/litellm";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { SafetyServiceError, type SafetyGuard } from "../src/services/safety";
import { messageText } from "../src/types";
import { createBillingService } from "../src/modules/billing/service";
import { buildServer } from "../src/server";
import { parseConfigObject } from "@modelgov/policy-engine";
import {
  DATABASE_URL,
  RAW_CONFIG,
  fakeEmbedClient,
  okEmbed,
  setupEmbeddings,
} from "./embeddingsHarness";

const SSN = /\d{3}-\d{2}-\d{4}/g;
// Fake safety guards exercising the embeddings input-PII contract without Presidio.
const maskGuard = (): SafetyGuard => ({
  async inspectInput(messages) {
    const masked = messages.map((m) => ({
      role: m.role,
      content: messageText(m.content).replace(SSN, "[REDACTED]"),
    }));
    const found = messages.some((m) => SSN.test(messageText(m.content)));
    return {
      action: "allow",
      messages: masked,
      piiMasked: found,
      injectionBlocked: false,
      findings: found ? [{ type: "pii", detail: "US_SSN" }] : [],
      safetyCostUsd: 0,
    };
  },
  async inspectOutput(content) {
    return { action: "allow", content, piiMasked: false, findings: [] };
  },
});
const blockGuard = (): SafetyGuard => ({
  async inspectInput() {
    return {
      action: "block",
      messages: [],
      piiMasked: false,
      injectionBlocked: false,
      findings: [{ type: "pii", detail: "US_SSN" }],
      blockReason: "pii_detected",
      safetyCostUsd: 0,
    };
  },
  async inspectOutput(content) {
    return { action: "allow", content, piiMasked: false, findings: [] };
  },
});
const throwGuard = (): SafetyGuard => ({
  async inspectInput() {
    throw new SafetyServiceError("presidio down");
  },
  async inspectOutput(content) {
    return { action: "allow", content, piiMasked: false, findings: [] };
  },
});

describe.skipIf(!DATABASE_URL)("POST /v1/embeddings (integration)", () => {
  const { pool: getPool, appWith, appWithSafety, post } = setupEmbeddings();

  /** An embed client that records the exact input it received. */
  function capturingEmbed(): { client: LiteLLMClient; seen: () => string[] | undefined } {
    let captured: string[] | undefined;
    const client = fakeEmbedClient(async (p) => {
      captured = p.input;
      return { embeddings: p.input.map(() => [0.1]), model: p.model, actualCostUsd: 0.00001, inputTokens: 8, raw: {} };
    });
    return { client, seen: () => captured };
  }

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

    const snap = await getPool().query(
      "SELECT used_usd FROM budget_counters WHERE scope='user_daily' AND key='svc1'",
    );
    expect(Number(snap.rows[0].used_usd)).toBeCloseTo(0.00001, 6);

    const logged = await getPool().query(
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

  describe("input PII safety", () => {
    it("masks input PII before sending it to the provider", async () => {
      const { client, seen } = capturingEmbed();
      const app = appWithSafety(client, maskGuard());
      const res = await post(app, {
        userId: "svc_pii",
        userType: "workflow",
        feature: "kb_embedding",
        input: ["my ssn is 123-45-6789", "no pii here"],
      });
      expect(res.statusCode).toBe(200);
      // The provider must never see the raw SSN.
      expect(seen()).toEqual(["my ssn is [REDACTED]", "no pii here"]);
      // The success audit row records that masking occurred (parity with chat).
      const log = await getPool().query(
        "SELECT pii_masked FROM request_logs WHERE user_id='svc_pii'",
      );
      expect(log.rows[0].pii_masked).toBe(true);
    });

    it("blocks the request with 403 and makes no provider call when PII must be blocked", async () => {
      const { client, seen } = capturingEmbed();
      const app = appWithSafety(client, blockGuard());
      const res = await post(app, {
        userId: "svc_block",
        userType: "workflow",
        feature: "kb_embedding",
        input: ["ssn 123-45-6789"],
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("safety_blocked");
      expect(res.json().error.details.reason).toBe("pii_detected");
      expect(seen()).toBeUndefined(); // provider never called
      const logs = await getPool().query(
        "SELECT status, error FROM request_logs WHERE user_id='svc_block'",
      );
      expect(logs.rows[0]).toMatchObject({ status: "safety_blocked", error: "pii_detected" });
    });

    it("fails closed with 503 (no provider call) when the safety backend is down", async () => {
      const { client, seen } = capturingEmbed();
      const app = appWithSafety(client, throwGuard());
      const res = await post(app, {
        userId: "svc_503",
        userType: "workflow",
        feature: "kb_embedding",
        input: ["hello"],
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("safety_unavailable");
      expect(seen()).toBeUndefined();
    });
  });

  describe("billing integration", () => {
    const billingConfig = parseConfigObject({
      ...RAW_CONFIG,
      billing: { provider: "stripe", mode: "credits_only" },
    });

    function appWithBilling(litellm: LiteLLMClient) {
      const billing = createBillingService(getPool(), { billing: billingConfig.billing })!;
      return {
        billing,
        app: buildServer({
          config: billingConfig,
          pool: getPool(),
          litellm,
          safety: new NoopGuard(),
          observability: new NoopObservability(),
          logger: false,
          allowUnauthenticated: true,
          billing,
        }),
      };
    }

    it("rejects with 402 when the wallet cannot cover the estimate (no provider call)", async () => {
      let providerRan = false;
      const spyEmbed = fakeEmbedClient(async (p) => {
        providerRan = true;
        return { embeddings: p.input.map(() => [0]), model: p.model, actualCostUsd: 0.1, inputTokens: 1, raw: {} };
      });
      const { app } = appWithBilling(spyEmbed);
      const res = await post(app, {
        userId: "u_broke",
        userType: "workflow",
        feature: "kb_embedding",
        input: ["hello"],
        // Large enough that the estimate is non-zero — a zero-rounded estimate
        // legitimately passes the pre-call gate (actual cost settles instead).
        inputTokensEstimate: 100_000,
      });
      expect(res.statusCode).toBe(402);
      expect(res.json().error.code).toBe("insufficient_credits");
      expect(providerRan).toBe(false);
      // The rejection leaves an audit row, like every other block path.
      const logs = await getPool().query(
        `SELECT error FROM request_logs WHERE user_id = 'u_broke'`,
      );
      expect(logs.rows).toEqual([{ error: "insufficient_credits" }]);
    });

    it("debits the wallet on success and releases the hold's leases", async () => {
      const { app, billing } = appWithBilling(okEmbed);
      await billing.adminTopUp({ tenantId: "", userId: "u_paid", creditsUsd: 1 });

      const res = await post(app, {
        userId: "u_paid",
        userType: "workflow",
        feature: "kb_embedding",
        input: ["hello"],
      });
      expect(res.statusCode).toBe(200);

      const balance = await billing.getBalance("", "u_paid");
      expect(balance.creditsUsd).toBeCloseTo(1 - 0.00001, 6);
      expect(balance.creditsReservedUsd).toBeCloseTo(0, 6);
      const leases = await getPool().query(`SELECT count(*)::int AS n FROM billing_reservation_leases`);
      expect(leases.rows[0].n).toBe(0);
    });

    it("metered mode records a meter event for embeddings spend", async () => {
      const meteredConfig = parseConfigObject({
        ...RAW_CONFIG,
        billing: {
          provider: "stripe",
          mode: "metered",
          stripe: { secret_key: "sk_test", meter_event_name: "modelgov_usage" },
        },
      });
      const billing = createBillingService(getPool(), { billing: meteredConfig.billing })!;
      const app = buildServer({
        config: meteredConfig,
        pool: getPool(),
        litellm: okEmbed,
        safety: new NoopGuard(),
        observability: new NoopObservability(),
        logger: false,
        allowUnauthenticated: true,
        billing,
      });
      const res = await post(app, {
        userId: "u_metered_embed",
        userType: "workflow",
        feature: "kb_embedding",
        input: ["hello"],
      });
      expect(res.statusCode).toBe(200);
      const meters = await getPool().query(
        `SELECT cost_usd::float8 AS cost_usd FROM meter_events WHERE user_id = 'u_metered_embed'`,
      );
      expect(meters.rows).toHaveLength(1);
      expect(Number(meters.rows[0].cost_usd)).toBeCloseTo(0.00001, 8);
    });

    // A pricier fallback grows the credit hold via the shared providerBudget.topUp
    // (same code chat uses). Both models are openai so the data-sensitivity gate
    // is irrelevant; the large model is 10x the price of the small one.
    const fallbackConfig = parseConfigObject({
      ...RAW_CONFIG,
      budgets: {
        ...RAW_CONFIG.budgets,
        by_user_type: {
          ...RAW_CONFIG.budgets.by_user_type,
          workflow: { daily_usd: 1, daily_requests: 100, models: ["embed", "embed_fb"] },
        },
      },
      features: { ...RAW_CONFIG.features, kb_embedding: { model_class: "embed_fb", max_tokens: 1 } },
      model_classes: {
        ...RAW_CONFIG.model_classes,
        embed_fb: { primary: "openai/text-embedding-3-small", fallback: "openai/text-embedding-3-large" },
      },
      pricing: {
        "openai/text-embedding-3-small": { input_per_1k: 0.00002, output_per_1k: 0 },
        "openai/text-embedding-3-large": { input_per_1k: 0.0002, output_per_1k: 0 },
      },
      billing: { provider: "stripe", mode: "credits_only" },
    });
    const primaryDownThenFallback = () =>
      fakeEmbedClient(async (p) => {
        if (p.model === "openai/text-embedding-3-small") throw new ProviderError("primary down");
        return { embeddings: p.input.map(() => [0.1]), model: p.model, actualCostUsd: 0.02, inputTokens: 8, raw: {} };
      });
    function appWithFallbackBilling(litellm: LiteLLMClient) {
      const billing = createBillingService(getPool(), { billing: fallbackConfig.billing })!;
      return {
        billing,
        app: buildServer({
          config: fallbackConfig,
          pool: getPool(),
          litellm,
          safety: new NoopGuard(),
          observability: new NoopObservability(),
          logger: false,
          allowUnauthenticated: true,
          billing,
        }),
      };
    }

    it("tops up the credit hold for a pricier fallback and settles the actual cost", async () => {
      const { app, billing } = appWithFallbackBilling(primaryDownThenFallback());
      await billing.adminTopUp({ tenantId: "", userId: "u_fb", creditsUsd: 1 });

      const res = await post(app, {
        userId: "u_fb",
        userType: "workflow",
        feature: "kb_embedding",
        input: ["hello"],
        inputTokensEstimate: 100_000, // primary est ~0.002, fallback est ~0.02
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().decision).toBe("fallback");

      const balance = await billing.getBalance("", "u_fb");
      expect(balance.creditsUsd).toBeCloseTo(1 - 0.02, 6); // debited the actual fallback cost
      expect(balance.creditsReservedUsd).toBeCloseTo(0, 6); // base + top-up hold fully released
      const leases = await getPool().query(`SELECT count(*)::int AS n FROM billing_reservation_leases`);
      expect(leases.rows[0].n).toBe(0);
    });

    it("rejects a pricier fallback the wallet can't cover, releasing the base hold (no leak)", async () => {
      const { app, billing } = appWithFallbackBilling(primaryDownThenFallback());
      // Covers the primary estimate (~0.002) but not the fallback top-up (~0.02).
      await billing.adminTopUp({ tenantId: "", userId: "u_fb_broke", creditsUsd: 0.005 });

      const res = await post(app, {
        userId: "u_fb_broke",
        userType: "workflow",
        feature: "kb_embedding",
        input: ["hello"],
        inputTokensEstimate: 100_000,
      });
      expect(res.statusCode).toBe(402);
      expect(res.json().error.code).toBe("insufficient_credits");

      const balance = await billing.getBalance("", "u_fb_broke");
      expect(balance.creditsUsd).toBeCloseTo(0.005, 6); // nothing debited
      expect(balance.creditsReservedUsd).toBeCloseTo(0, 6); // base hold released, not stranded
      const leases = await getPool().query(`SELECT count(*)::int AS n FROM billing_reservation_leases`);
      expect(leases.rows[0].n).toBe(0);
    });
  });
});
