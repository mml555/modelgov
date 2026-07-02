import { parseConfigObject, type SafetyPlan } from "@ai-guard/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import type { LiteLLMChatParams, LiteLLMChatResult, LiteLLMClient } from "../src/services/litellm";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard, type OutputSafetyResult, type SafetyGuard, type SafetyResult } from "../src/services/safety";
import { buildServer } from "../src/server";
import { GROUNDING_REFUSAL } from "../src/modules/chat/grounding";
import type { ChatMessage } from "../src/types";

const DATABASE_URL = process.env.DATABASE_URL;

const RAW_CONFIG = {
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
    by_user_type: {
      logged_in: { daily_usd: 1, daily_requests: 100, models: ["cheap"] },
    },
  },
  features: {
    grounded_support: {
      safety: { preset: "dev", grounding: "strict" },
      model_class: "cheap",
      max_tokens: 500,
    },
    // Grounding AND output PII masking together — the ordering regression.
    grounded_masked: {
      safety: { protect: { pii: "mask" }, grounding: "strict" },
      model_class: "cheap",
      max_tokens: 500,
    },
  },
  model_classes: {
    cheap: { primary: "openai/gpt-4o-mini" },
  },
  safety: { preset: "dev" },
};

const config = parseConfigObject(RAW_CONFIG);

const CONTEXT = [
  "Refunds are processed within 5 business days to the original payment method.",
];

function chatReturning(content: string, capture?: (p: LiteLLMChatParams) => void): LiteLLMClient {
  return {
    chat: async (p): Promise<LiteLLMChatResult> => {
      capture?.(p);
      return { content, model: p.model, actualCostUsd: 0.0001, inputTokens: 20, outputTokens: 10, raw: {} };
    },
    // minimal stream impl so the streaming gate (not "not implemented") is exercised
    async *chatStream() {
      yield { delta: "x" };
      return { model: "openai/gpt-4o-mini", actualCostUsd: 0, inputTokens: 1, outputTokens: 1 };
    },
  };
}

describe.skipIf(!DATABASE_URL)("grounding (integration)", () => {
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

  function appWith(litellm: LiteLLMClient, safety: SafetyGuard = new NoopGuard()): FastifyInstance {
    return buildServer({
      config,
      pool,
      litellm,
      safety,
      observability: new NoopObservability(),
      logger: false,
      allowUnauthenticated: true,
    });
  }

  // Passes input through; masks a specific email in the OUTPUT (like Presidio).
  const emailMaskingSafety: SafetyGuard = {
    async inspectInput(messages: ChatMessage[]): Promise<SafetyResult> {
      return { action: "allow", messages, piiMasked: false, injectionBlocked: false, findings: [], safetyCostUsd: 0 };
    },
    async inspectOutput(content: string, _plan: SafetyPlan): Promise<OutputSafetyResult> {
      const masked = content.replace(/jane@example\.com/g, "[REDACTED]");
      return { action: "allow", content: masked, piiMasked: masked !== content, findings: [] };
    },
  };

  const post = (app: FastifyInstance, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/v1/chat", payload: body });

  it("requires a context block for a grounded feature", async () => {
    const app = appWith(chatReturning("{}"));
    const res = await post(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "grounded_support",
      messages: [{ role: "user", content: "how long do refunds take?" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("grounding_context_required");
  });

  it("injects the grounded prompt and returns a verified answer", async () => {
    let seen: LiteLLMChatParams | undefined;
    const modelOut = JSON.stringify({
      found: true,
      answer: "Refunds are processed within 5 business days.",
      quotes: ["Refunds are processed within 5 business days"],
    });
    const app = appWith(chatReturning(modelOut, (p) => (seen = p)));
    const res = await post(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "grounded_support",
      context: CONTEXT,
      messages: [{ role: "user", content: "how long do refunds take?" }],
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.safety.grounded).toBe(true);
    expect(json.message.content).toContain("5 business days");
    // The gateway owns the grounded prompt: a system message carrying the
    // context was prepended before the caller's message.
    expect(seen?.messages[0]?.role).toBe("system");
    expect(String(seen?.messages[0]?.content)).toContain("Refunds are processed");
  });

  it("replaces an unverifiable (fabricated) answer with a safe refusal", async () => {
    const modelOut = JSON.stringify({
      found: true,
      answer: "Refunds take 30 days.",
      quotes: ["Refunds are processed within 30 business days"],
    });
    const app = appWith(chatReturning(modelOut));
    const res = await post(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "grounded_support",
      context: CONTEXT,
      messages: [{ role: "user", content: "how long do refunds take?" }],
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.safety.grounded).toBe(false);
    expect(json.message.content).toBe(GROUNDING_REFUSAL);
  });

  it("rejects streaming for a grounded feature", async () => {
    const app = appWith(chatReturning("{}"));
    const res = await post(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "grounded_support",
      context: CONTEXT,
      stream: true,
      messages: [{ role: "user", content: "how long do refunds take?" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("streaming_unsupported");
  });

  it("verifies grounding on the RAW output, then masks PII in the answer", async () => {
    // Model returns valid grounded JSON whose answer contains an email. If PII
    // masking ran BEFORE grounding it would mangle the JSON and force a refusal;
    // the correct order verifies first, then masks the extracted answer.
    const modelOut = JSON.stringify({
      found: true,
      answer: "Refunds are processed within 5 business days — questions to jane@example.com.",
      quotes: ["Refunds are processed within 5 business days"],
    });
    const app = appWith(chatReturning(modelOut), emailMaskingSafety);
    const res = await post(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "grounded_masked",
      context: CONTEXT,
      messages: [{ role: "user", content: "how long do refunds take?" }],
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    // Grounding still succeeds (it saw the raw JSON)...
    expect(json.safety.grounded).toBe(true);
    // ...and the email in the answer was masked afterward.
    expect(json.safety.piiMasked).toBe(true);
    expect(json.message.content).toContain("5 business days");
    expect(json.message.content).toContain("[REDACTED]");
    expect(json.message.content).not.toContain("jane@example.com");
  });
});
