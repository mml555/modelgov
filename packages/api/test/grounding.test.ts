import { describe, expect, it } from "vitest";
import {
  buildGroundedMessages,
  GROUNDING_REFUSAL,
  verifyGrounding,
} from "../src/modules/chat/grounding";

const context = [
  "Refunds are processed within 5 business days to the original payment method.",
  "Our support hours are 9am to 5pm Eastern, Monday through Friday.",
];

describe("verifyGrounding", () => {
  it("accepts an answer whose quotes appear verbatim in the context", () => {
    const out = JSON.stringify({
      found: true,
      answer: "Refunds take 5 business days.",
      quotes: ["Refunds are processed within 5 business days"],
    });
    const v = verifyGrounding(out, context);
    expect(v.grounded).toBe(true);
    expect(v.answer).toContain("5 business days");
    expect(v.verifiedQuotes).toBe(1);
  });

  it("refuses when the model reports the answer is not in the context", () => {
    const out = JSON.stringify({ found: false, answer: "not sure", quotes: [] });
    const v = verifyGrounding(out, context);
    expect(v.grounded).toBe(false);
    expect(v.answer).toBe(GROUNDING_REFUSAL);
  });

  it("refuses a fabricated citation that is not present in the context", () => {
    const out = JSON.stringify({
      found: true,
      answer: "Refunds take 30 days.",
      quotes: ["Refunds are processed within 30 business days"],
    });
    expect(verifyGrounding(out, context).grounded).toBe(false);
  });

  it("refuses unparseable model output", () => {
    expect(verifyGrounding("I think refunds take a while.", context).grounded).toBe(false);
  });

  it("refuses trivially short quotes that would match anything", () => {
    const out = JSON.stringify({ found: true, answer: "yes", quotes: ["the"] });
    expect(verifyGrounding(out, context).grounded).toBe(false);
  });

  it("tolerates whitespace and case differences in citations", () => {
    const out = JSON.stringify({
      found: true,
      answer: "9-5 ET, weekdays.",
      quotes: ["support hours are  9AM to 5PM eastern"],
    });
    expect(verifyGrounding(out, context).grounded).toBe(true);
  });

  it("extracts the JSON object even when wrapped in prose / code fences", () => {
    const out =
      "Sure!\n```json\n" +
      JSON.stringify({
        found: true,
        answer: "5 business days.",
        quotes: ["Refunds are processed within 5 business days"],
      }) +
      "\n```";
    expect(verifyGrounding(out, context).grounded).toBe(true);
  });

  it("parses JSON even when trailing prose contains braces", () => {
    const out =
      JSON.stringify({
        found: true,
        answer: "5 business days.",
        quotes: ["Refunds are processed within 5 business days"],
      }) + "  (see clause {3} for details)";
    expect(verifyGrounding(out, context).grounded).toBe(true);
  });

  it("verifies a quote that includes the [N] citation marker the model was shown", () => {
    const out = JSON.stringify({
      found: true,
      answer: "5 business days.",
      quotes: ["[1] Refunds are processed within 5 business days"],
    });
    expect(verifyGrounding(out, context).grounded).toBe(true);
  });

  it("parses the object even when LEADING prose contains a stray brace", () => {
    const out =
      "Result for item {A}: " +
      JSON.stringify({
        found: true,
        answer: "5 business days.",
        quotes: ["Refunds are processed within 5 business days"],
      });
    expect(verifyGrounding(out, context).grounded).toBe(true);
  });

  it("does not let a marker prefix smuggle a trivially short quote past the length gate", () => {
    // Stripped content is just "refunds" (7 chars) — below MIN_QUOTE_CHARS — even
    // though "[1] refunds" is 11+. Must be rejected, not verified.
    const out = JSON.stringify({
      found: true,
      answer: "refunds info",
      quotes: ["[1] refunds"],
    });
    expect(verifyGrounding(out, context).grounded).toBe(false);
  });

  it("refuses a fabricated NUMBER even when the cited quote is genuinely present", () => {
    // Quote is verbatim from the context, but the answer invents "10" (context
    // only says 5). Quote-presence alone must not certify the numeric claim.
    const out = JSON.stringify({
      found: true,
      answer: "Refunds take 10 business days.",
      quotes: ["Refunds are processed within 5 business days"],
    });
    expect(verifyGrounding(out, context).grounded).toBe(false);
  });

  it("refuses a quote that straddles two separate passages", () => {
    // Neither passage individually contains this span; only the naive joined
    // blob would. Must NOT verify.
    const out = JSON.stringify({
      found: true,
      answer: "made up",
      quotes: ["to the original payment method. Our support hours are 9am"],
    });
    expect(verifyGrounding(out, context).grounded).toBe(false);
  });
});

describe("buildGroundedMessages", () => {
  it("prepends a system prompt carrying the context and keeps caller messages", () => {
    const msgs = buildGroundedMessages(
      [{ role: "user", content: "how long do refunds take?" }],
      context,
    );
    expect(msgs[0]?.role).toBe("system");
    expect(String(msgs[0]?.content)).toContain("Refunds are processed");
    expect(msgs[1]).toEqual({ role: "user", content: "how long do refunds take?" });
  });
});
