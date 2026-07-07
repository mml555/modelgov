import { describe, expect, it } from "vitest";
import { parseConfigObject } from "@modelgov/policy-engine";
import { buildAiRequest, estimateInputTokensFromMessages } from "../src/modules/chat/prep";
import type { ChatInput } from "../src/modules/chat/types";

const config = parseConfigObject({
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 100, hard_stop_at_percent: 100 },
    by_user_type: { t: { daily_usd: 10, daily_requests: 100, models: ["cheap"] } },
  },
  features: { f: { safety: "dev", model_class: "cheap", max_tokens: 100 } },
  model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
  safety: { preset: "dev" },
});

function body(over: Partial<ChatInput>): ChatInput {
  return { userId: "u", userType: "t", feature: "f", messages: [{ role: "user", content: "hi" }], ...over };
}

describe("server-side input-token floor (H4)", () => {
  it("estimates from text content length (~4 chars/token)", () => {
    const text = "x".repeat(400); // ~100 tokens
    expect(estimateInputTokensFromMessages([{ role: "user", content: text }])).toBe(100);
  });

  it("counts image parts at a per-image floor", () => {
    const tokens = estimateInputTokensFromMessages([
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    ]);
    expect(tokens).toBeGreaterThanOrEqual(1000);
  });

  it("ignores a client estimate that under-declares the real content size", () => {
    // ~25k chars ≈ 6250 tokens of real prompt, declared as 1.
    const big = "a".repeat(25_000);
    const req = buildAiRequest(
      body({ messages: [{ role: "user", content: big }], inputTokensEstimate: 1 }),
      config,
    );
    expect(req.inputTokensEstimate).toBeGreaterThan(6000);
  });

  it("includes grounding context in the floor (can't under-declare via context)", () => {
    // Small messages, tiny declared estimate, but a huge context passage: the
    // floor must reflect the context that a grounded feature sends to the model.
    const bigContext = "c".repeat(40_000); // ~10k tokens
    const req = buildAiRequest(
      body({ messages: [{ role: "user", content: "hi" }], context: [bigContext], inputTokensEstimate: 1 }),
      config,
    );
    expect(req.inputTokensEstimate).toBeGreaterThan(9000);
  });

  it("honors a client estimate that is LARGER than the content floor", () => {
    const req = buildAiRequest(body({ messages: [{ role: "user", content: "hi" }], inputTokensEstimate: 5000 }), config);
    expect(req.inputTokensEstimate).toBe(5000);
  });

  it("falls back to the content floor when the client omits an estimate", () => {
    const text = "y".repeat(2000); // ~500 tokens
    const req = buildAiRequest(body({ messages: [{ role: "user", content: text }] }), config);
    expect(req.inputTokensEstimate).toBe(500);
  });
});
