import type { PiiEntityPolicy, SafetyPlan } from "@modelgov/policy-engine";
import { describe, expect, it, vi } from "vitest";
import { CompositeGuard } from "../src/services/safety/composite";
import { PresidioPiiGuard } from "../src/services/safety/presidio";
import type { PiiGuard, SafetyFinding } from "../src/services/safety/contracts";

// Per-entity PII policy: the disposition of each detected entity decides
// mask/block/allow, instead of one mode flattening the whole request.

const plan = (over: Partial<SafetyPlan> = {}): SafetyPlan => ({
  preset: "custom",
  pii: "mask",
  piiScope: "both",
  promptInjection: "off",
  maxOutputTokens: 100,
  grounding: "off",
  ...over,
});

/** Presidio analyzer/anonymizer stubbed over fetch. */
function presidio(detected: Array<{ type: string; start: number; end: number }>) {
  const anonymizeCalls: Array<Array<Record<string, unknown>>> = [];
  const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    if (String(url).includes("/analyze")) {
      return new Response(
        JSON.stringify(detected.map((d) => ({ entity_type: d.type, start: d.start, end: d.end, score: 0.9 }))),
        { status: 200 },
      );
    }
    anonymizeCalls.push(body.analyzer_results as Array<Record<string, unknown>>);
    return new Response(JSON.stringify({ text: "[MASKED]" }), { status: 200 });
  });
  const guard = new PresidioPiiGuard({
    analyzerUrl: "http://a",
    anonymizerUrl: "http://b",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { guard, fetchImpl, anonymizeCalls };
}

const msg = (content: string) => [{ role: "user" as const, content }];

describe("PresidioPiiGuard per-entity dispositions", () => {
  const policy = (p: Partial<PiiEntityPolicy>): PiiEntityPolicy => ({ default: "mask", ...p });

  it("masks everything when no policy is supplied (unchanged behaviour)", async () => {
    const { guard, anonymizeCalls } = presidio([
      { type: "PERSON", start: 0, end: 4 },
      { type: "US_SSN", start: 5, end: 16 },
    ]);
    const r = await guard.process(msg("Jane 123-45-6789"));
    expect(r.messages[0]?.content).toBe("[MASKED]");
    expect(anonymizeCalls[0]).toHaveLength(2);
    // No policy in play, so no disposition is claimed.
    expect(r.findings.every((f) => f.disposition === undefined)).toBe(true);
  });

  it("sends ONLY mask-dispositioned entities to the anonymizer", async () => {
    const { guard, anonymizeCalls } = presidio([
      { type: "PERSON", start: 0, end: 4 },
      { type: "US_SSN", start: 5, end: 16 },
    ]);
    const r = await guard.process(msg("Jane 123-45-6789"), policy({ allow: ["PERSON"] }));
    expect(anonymizeCalls[0]?.map((e) => e.entity_type)).toEqual(["US_SSN"]);
    expect(r.findings.map((f) => [f.detail, f.disposition])).toEqual([
      ["PERSON", "allow"],
      ["US_SSN", "mask"],
    ]);
  });

  it("skips the anonymizer entirely when nothing is dispositioned mask", async () => {
    const { guard, anonymizeCalls, fetchImpl } = presidio([{ type: "PERSON", start: 0, end: 4 }]);
    const r = await guard.process(msg("Jane"), policy({ allow: ["PERSON"] }));
    // Text untouched, and no pointless round-trip.
    expect(r.messages[0]?.content).toBe("Jane");
    expect(anonymizeCalls).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("records an allowed entity as a finding rather than staying silent", async () => {
    // "We saw a PERSON and deliberately passed it through" is the claim a
    // compliance review needs; silence cannot make it.
    const { guard } = presidio([{ type: "PERSON", start: 0, end: 4 }]);
    const r = await guard.process(msg("Jane"), policy({ allow: ["PERSON"] }));
    expect(r.findings).toEqual([{ type: "pii", detail: "PERSON", disposition: "allow" }]);
  });

  it("leaves a block-dispositioned entity in the text (the block needs its evidence)", async () => {
    const { guard, anonymizeCalls } = presidio([{ type: "US_SSN", start: 0, end: 11 }]);
    const r = await guard.process(msg("123-45-6789"), policy({ block: ["US_SSN"], default: "allow" }));
    expect(r.messages[0]?.content).toBe("123-45-6789");
    expect(anonymizeCalls).toHaveLength(0);
    expect(r.findings[0]?.disposition).toBe("block");
  });

  it("applies `default` to an entity in none of the lists", async () => {
    const { guard, anonymizeCalls } = presidio([
      { type: "PERSON", start: 0, end: 4 },
      { type: "CREDIT_CARD", start: 5, end: 9 },
    ]);
    // Deny-list semantics: mask only what is named.
    await guard.process(msg("Jane 4111"), policy({ mask: ["CREDIT_CARD"], default: "allow" }));
    expect(anonymizeCalls[0]?.map((e) => e.entity_type)).toEqual(["CREDIT_CARD"]);
  });

  it("defaults unlisted entities to MASK so a forgotten type does not leak", async () => {
    const { guard, anonymizeCalls } = presidio([
      { type: "PERSON", start: 0, end: 4 },
      { type: "US_SSN", start: 5, end: 16 },
    ]);
    // Author named PERSON only; US_SSN must still be redacted.
    await guard.process(msg("Jane 123-45-6789"), policy({ allow: ["PERSON"] }));
    expect(anonymizeCalls[0]?.map((e) => e.entity_type)).toEqual(["US_SSN"]);
  });
});

describe("PresidioPiiGuard concurrency", () => {
  it("caps in-flight analyzer requests instead of one socket per leaf", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (url: unknown) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return String(url).includes("/analyze")
        ? new Response("[]", { status: 200 })
        : new Response(JSON.stringify({ text: "x" }), { status: 200 });
    });
    const guard = new PresidioPiiGuard({
      analyzerUrl: "http://a",
      anonymizerUrl: "http://b",
      maxConcurrency: 4,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // A 200-cell table's worth of leaves.
    const many = Array.from({ length: 200 }, (_, i) => ({ role: "user" as const, content: `c${i}` }));
    const r = await guard.process(many);
    expect(peak).toBeLessThanOrEqual(4);
    expect(fetchImpl).toHaveBeenCalledTimes(200);
    // Order must survive the bounded dispatch.
    expect(r.messages.map((m) => m.content)).toEqual(many.map((m) => m.content));
  });

  it("caps a SINGLE multimodal message with many text parts", async () => {
    // Bounding only the top level left one message with 200 parts free to open
    // 200 sockets — the exact exhaustion the limit exists to prevent.
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (url: unknown) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return String(url).includes("/analyze")
        ? new Response("[]", { status: 200 })
        : new Response(JSON.stringify({ text: "x" }), { status: 200 });
    });
    const guard = new PresidioPiiGuard({
      analyzerUrl: "http://a",
      anonymizerUrl: "http://b",
      maxConcurrency: 4,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const parts = Array.from({ length: 200 }, (_, i) => ({ type: "text" as const, text: `p${i}` }));
    const r = await guard.process([{ role: "user", content: parts }]);
    expect(peak).toBeLessThanOrEqual(4);
    expect(fetchImpl).toHaveBeenCalledTimes(200);
    expect(r.messages[0]?.content).toEqual(parts);
  });

  it("passes image parts through and keeps text parts aligned", async () => {
    // Flattening must not shift a masked string onto the wrong part.
    const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
      if (String(url).includes("/analyze")) {
        const { text } = JSON.parse(String((init as RequestInit).body)) as { text: string };
        return new Response(
          text === "secret" ? JSON.stringify([{ entity_type: "US_SSN", start: 0, end: 6, score: 0.9 }]) : "[]",
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ text: "[MASKED]" }), { status: 200 });
    });
    const guard = new PresidioPiiGuard({
      analyzerUrl: "http://a",
      anonymizerUrl: "http://b",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await guard.process([
      { role: "user", content: [
        { type: "text", text: "clean" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        { type: "text", text: "secret" },
      ] },
      { role: "user", content: "also clean" },
    ]);
    expect(r.messages[0]?.content).toEqual([
      { type: "text", text: "clean" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      { type: "text", text: "[MASKED]" },
    ]);
    expect(r.messages[1]?.content).toBe("also clean");
    expect(r.findings).toEqual([{ type: "pii", detail: "US_SSN" }]);
  });

  it("does not mutate the caller's messages", async () => {
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).includes("/analyze")
        ? new Response(JSON.stringify([{ entity_type: "US_SSN", start: 0, end: 3, score: 0.9 }]), { status: 200 })
        : new Response(JSON.stringify({ text: "[MASKED]" }), { status: 200 }),
    );
    const guard = new PresidioPiiGuard({
      analyzerUrl: "http://a",
      anonymizerUrl: "http://b",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const original = [{ role: "user" as const, content: [{ type: "text" as const, text: "ssn" }] }];
    await guard.process(original);
    expect(original[0]?.content).toEqual([{ type: "text", text: "ssn" }]);
  });
});

/** A PiiGuard returning fixed findings, to drive CompositeGuard directly. */
function stubGuard(findings: SafetyFinding[], masked = "[MASKED]"): PiiGuard {
  return {
    async process(messages) {
      return { messages: messages.map((m) => ({ ...m, content: masked })), findings };
    },
  };
}

describe("CompositeGuard with per-entity policy", () => {
  const entities: PiiEntityPolicy = { allow: ["PERSON"], block: ["US_SSN"], default: "mask" };

  it("does NOT block on a finding that is merely allowed", async () => {
    // The coarse mode is "block" (US_SSN could block), so keying off plan.pii
    // alone would reject a request whose only finding was an allowed PERSON.
    const guard = new CompositeGuard(
      stubGuard([{ type: "pii", detail: "PERSON", disposition: "allow" }]),
      null,
    );
    const res = await guard.inspectInput(msg("Jane"), plan({ pii: "block", piiEntities: entities }));
    expect(res.action).toBe("allow");
    // Nothing was redacted, so nothing may claim it was.
    expect(res.piiMasked).toBe(false);
  });

  it("blocks when a block-dispositioned entity is present", async () => {
    const guard = new CompositeGuard(
      stubGuard([
        { type: "pii", detail: "PERSON", disposition: "allow" },
        { type: "pii", detail: "US_SSN", disposition: "block" },
      ]),
      null,
    );
    const res = await guard.inspectInput(msg("Jane 123-45-6789"), plan({ pii: "block", piiEntities: entities }));
    expect(res.action).toBe("block");
    expect(res.blockReason).toBe("pii_detected");
  });

  it("reports piiMasked only when something was actually redacted", async () => {
    const guard = new CompositeGuard(
      stubGuard([{ type: "pii", detail: "EMAIL_ADDRESS", disposition: "mask" }]),
      null,
    );
    const res = await guard.inspectInput(msg("a@b.com"), plan({ pii: "mask", piiEntities: entities }));
    expect(res.piiMasked).toBe(true);
  });

  it("keeps blanket-mode behaviour when no entity policy is set", async () => {
    const guard = new CompositeGuard(stubGuard([{ type: "pii", detail: "PERSON" }]), null);
    expect((await guard.inspectInput(msg("Jane"), plan({ pii: "block" }))).action).toBe("block");
    expect((await guard.inspectInput(msg("Jane"), plan({ pii: "mask" }))).piiMasked).toBe(true);
  });
});

describe("CompositeGuard.inspectOutputMany", () => {
  it("masks every leaf in one backend pass", async () => {
    let calls = 0;
    const pii: PiiGuard = {
      async process(messages) {
        calls += 1;
        return {
          messages: messages.map((m) => ({ ...m, content: "[MASKED]" })),
          findings: [{ type: "pii", detail: "US_SSN", disposition: "mask" }],
        };
      },
    };
    const res = await new CompositeGuard(pii, null).inspectOutputMany(["a", "b", "c"], plan());
    expect(res.contents).toEqual(["[MASKED]", "[MASKED]", "[MASKED]"]);
    expect(res.piiMasked).toBe(true);
    // One pass, not one per leaf — a 200-cell table must not be 200 round-trips.
    expect(calls).toBe(1);
  });

  it("fails closed rather than pairing masked text with the wrong leaf", async () => {
    const pii: PiiGuard = {
      async process() {
        return { messages: [{ role: "assistant", content: "[MASKED]" }], findings: [{ type: "pii" }] };
      },
    };
    await expect(
      new CompositeGuard(pii, null).inspectOutputMany(["a", "b"], plan()),
    ).rejects.toThrow(/mismatched/i);
  });

  it("blocks the whole payload when any leaf carries a blocking entity", async () => {
    // The leaves are one document; returning the rest would leak by omission.
    const pii = stubGuard([{ type: "pii", detail: "US_SSN", disposition: "block" }]);
    const res = await new CompositeGuard(pii, null).inspectOutputMany(
      ["clean", "123-45-6789"],
      plan({ pii: "block", piiEntities: { block: ["US_SSN"], default: "mask" } }),
    );
    expect(res.action).toBe("block");
    expect(res.blockReason).toBe("output_pii_detected");
  });

  it("is a no-op when PII is off or scoped to input only", async () => {
    const guard = new CompositeGuard(stubGuard([{ type: "pii" }]), null);
    expect((await guard.inspectOutputMany(["a"], plan({ pii: "off" }))).contents).toEqual(["a"]);
    expect((await guard.inspectOutputMany(["a"], plan({ piiScope: "input" }))).contents).toEqual(["a"]);
  });
});
