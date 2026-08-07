import type { SafetyPlan } from "@modelgov/policy-engine";
import { describe, expect, it, vi } from "vitest";
import { maskStructuredOutput } from "../src/modules/chat/structuredOutput";
import type { SafetyGuard } from "../src/services/safety";

// Output PII masking for a /chat responseFormat payload. `inspectOutput` treats
// the completion as prose and rewrites spans in the serialized text; for JSON
// that risks the structure, not just the values.

const plan = (over: Partial<SafetyPlan> = {}): SafetyPlan => ({
  preset: "custom",
  pii: "mask",
  piiScope: "both",
  promptInjection: "off",
  maxOutputTokens: 100,
  grounding: "off",
  ...over,
});

/** Redacts any value containing a digit run; leaves everything else alone. */
function guard(over: Partial<SafetyGuard> = {}): SafetyGuard {
  return {
    inspectInput: vi.fn(),
    inspectOutput: vi.fn(async (content: string) => ({
      action: "allow" as const,
      content: content.replace(/\d[\d-]{4,}/g, "[REDACTED]"),
      piiMasked: /\d[\d-]{4,}/.test(content),
      findings: [],
    })),
    inspectOutputMany: vi.fn(async (contents: string[]) => {
      const out = contents.map((c) => c.replace(/\d[\d-]{4,}/g, "[REDACTED]"));
      return {
        action: "allow" as const,
        contents: out,
        piiMasked: out.some((c, i) => c !== contents[i]),
        findings: [],
      };
    }),
    ...over,
  } as SafetyGuard;
}

describe("maskStructuredOutput", () => {
  it("masks string leaves and leaves the JSON well-formed", async () => {
    const body = JSON.stringify({ name: "Jane Roe", ssn: "123-45-6789" });
    const r = await maskStructuredOutput(guard(), body, plan());
    expect(r.structured).toBe(true);
    expect(r.masked).toBe(true);
    expect(JSON.parse(r.content)).toEqual({ name: "Jane Roe", ssn: "[REDACTED]" });
  });

  it("does NOT mask object keys", async () => {
    // Keys come from the caller's schema, not the model. Rewriting one would
    // break the contract the schema states.
    const body = JSON.stringify({ "123-45-6789": "value" });
    const r = await maskStructuredOutput(guard(), body, plan());
    expect(Object.keys(JSON.parse(r.content))).toEqual(["123-45-6789"]);
  });

  it("recurses into nested objects and arrays", async () => {
    const body = JSON.stringify({
      people: [{ ssn: "123-45-6789" }, { ssn: "987-65-4321" }],
      nested: { deep: { ssn: "111-22-3333" } },
      tags: ["444-55-6666", "clean"],
    });
    const r = await maskStructuredOutput(guard(), body, plan());
    const out = JSON.parse(r.content);
    expect(out.people.map((p: { ssn: string }) => p.ssn)).toEqual(["[REDACTED]", "[REDACTED]"]);
    expect(out.nested.deep.ssn).toBe("[REDACTED]");
    expect(out.tags).toEqual(["[REDACTED]", "clean"]);
  });

  it("leaves non-string values alone rather than coercing them", async () => {
    const body = JSON.stringify({ count: 123456, ok: true, nothing: null });
    const r = await maskStructuredOutput(guard(), body, plan());
    expect(JSON.parse(r.content)).toEqual({ count: 123456, ok: true, nothing: null });
    expect(r.masked).toBe(false);
  });

  it("reports masked=false when nothing was rewritten", async () => {
    const r = await maskStructuredOutput(guard(), JSON.stringify({ a: "clean" }), plan());
    expect(r.masked).toBe(false);
    expect(r.structured).toBe(true);
  });

  it("uses ONE backend pass for the whole payload", async () => {
    const g = guard();
    await maskStructuredOutput(g, JSON.stringify({ a: "1-1111", b: "2-2222", c: "3-3333" }), plan());
    expect(g.inspectOutputMany).toHaveBeenCalledOnce();
  });

  it("falls back when the model ignored responseFormat and returned prose", async () => {
    // structured:false tells the caller to run ordinary prose masking rather
    // than skip output safety altogether.
    const r = await maskStructuredOutput(guard(), "I'm sorry, I can't do that.", plan());
    expect(r.structured).toBe(false);
  });

  it("falls back for a bare JSON scalar", async () => {
    for (const body of ['"just a string"', "42", "null"]) {
      expect((await maskStructuredOutput(guard(), body, plan())).structured).toBe(false);
    }
  });

  it("falls back when the guard cannot batch", async () => {
    const g = guard();
    delete (g as { inspectOutputMany?: unknown }).inspectOutputMany;
    expect((await maskStructuredOutput(g, JSON.stringify({ a: "x" }), plan())).structured).toBe(false);
  });

  it("propagates a block without returning the payload", async () => {
    const g = guard({
      inspectOutputMany: vi.fn(async (contents: string[]) => ({
        action: "block" as const,
        contents,
        piiMasked: false,
        findings: [{ type: "pii" as const, detail: "US_SSN" }],
        blockReason: "output_pii_detected" as const,
      })),
    });
    const r = await maskStructuredOutput(g, JSON.stringify({ ssn: "123-45-6789" }), plan());
    expect(r.action).toBe("block");
    expect(r.blockReason).toBe("output_pii_detected");
    expect(r.masked).toBe(false);
  });

  it("fails closed on a mismatched masked-value count", async () => {
    // Never pair a masked value with the wrong field, and never fall back to
    // the original — it still holds the PII we were asked to redact.
    const g = guard({
      inspectOutputMany: vi.fn(async () => ({
        action: "allow" as const,
        contents: ["only-one"],
        piiMasked: true,
        findings: [],
      })),
    });
    await expect(
      maskStructuredOutput(g, JSON.stringify({ a: "1-1111", b: "2-2222" }), plan()),
    ).rejects.toThrow(/mismatched/i);
  });

  it("keeps the payload parseable where a text pass could not", async () => {
    // The bug this exists to prevent: a prose pass rewrites spans in the
    // SERIALIZED text, so a detected span covering a delimiter damages the
    // document. Masking leaves cannot, by construction.
    const evil = guard({
      inspectOutput: vi.fn(async () => ({
        action: "allow" as const,
        // A span that swallowed the closing quote and comma.
        content: '{"a": [REDACTED] "b": "y"}',
        piiMasked: true,
        findings: [],
      })),
    });
    const body = JSON.stringify({ a: "123-45-6789", b: "y" });
    const prose = await evil.inspectOutput(body, plan());
    expect(() => JSON.parse(prose.content)).toThrow();

    const r = await maskStructuredOutput(guard(), body, plan());
    expect(() => JSON.parse(r.content)).not.toThrow();
  });
});
