import { describe, expect, it } from "vitest";
import { parseConfigObject } from "../src/config";
import { resolveSafetyPlan } from "../src/safety";
import { PolicyConfigError } from "../src/types";
import { RAW_CONFIG } from "./helpers";

/** RAW_CONFIG with the global safety block and features overridden. */
function cfg(safety: unknown, features: Record<string, unknown>) {
  return parseConfigObject({ ...RAW_CONFIG, safety, features });
}

const plan = (safety: unknown, feature: unknown) => {
  const config = cfg(safety, { f: feature });
  return resolveSafetyPlan(config, config.features["f"]!);
};

const FEATURE = { model_class: "cheap", max_tokens: 100 };

describe("grounding config — the bare string keeps working", () => {
  it("accepts `grounding: strict` as a feature override", () => {
    const p = plan({ preset: "balanced" }, { ...FEATURE, safety: { grounding: "strict" } });
    expect(p.grounding).toBe("strict");
    // No block was written, so nothing overrides the built-in copy.
    expect(p.groundingOptions).toEqual({ persona: undefined, refusal: undefined, cite: undefined });
  });

  it("accepts `grounding: strict` as a global default", () => {
    expect(plan({ preset: "balanced", grounding: "strict" }, FEATURE).grounding).toBe("strict");
  });

  it("is off when nothing sets it", () => {
    const p = plan({ preset: "balanced" }, FEATURE);
    expect(p.grounding).toBe("off");
    expect(p.groundingOptions).toBeUndefined();
  });
});

describe("grounding config — the object form", () => {
  it("carries persona, refusal and citation fields onto the plan", () => {
    const p = plan(
      { preset: "balanced" },
      {
        ...FEATURE,
        safety: {
          grounding: {
            mode: "strict",
            persona: "You are a claims assistant.",
            refusal: "I couldn't find that in the policy documents.",
            cite: ["page", "section"],
          },
        },
      },
    );
    expect(p.grounding).toBe("strict");
    expect(p.groundingOptions).toEqual({
      persona: "You are a claims assistant.",
      refusal: "I couldn't find that in the policy documents.",
      cite: ["page", "section"],
    });
  });

  it("drops the copy when the block resolves to off", () => {
    // Carrying a persona for a feature with no grounding would imply something
    // is enforcing it.
    const p = plan(
      { preset: "balanced" },
      { ...FEATURE, safety: { grounding: { mode: "off", persona: "You are a claims assistant." } } },
    );
    expect(p.grounding).toBe("off");
    expect(p.groundingOptions).toBeUndefined();
  });

  it("replaces the global block WHOLESALE rather than merging field-by-field", () => {
    // A feature that sets its own persona must not inherit a refusal string
    // written for a different desk.
    const p = plan(
      {
        preset: "balanced",
        grounding: { mode: "strict", persona: "You are a support agent.", refusal: "Ask a human." },
      },
      { ...FEATURE, safety: { grounding: { mode: "strict", persona: "You are a claims assistant." } } },
    );
    expect(p.groundingOptions?.persona).toBe("You are a claims assistant.");
    expect(p.groundingOptions?.refusal).toBeUndefined();
  });

  it("inherits the global block when the feature says nothing", () => {
    const p = plan(
      { preset: "balanced", grounding: { mode: "strict", persona: "You are a claims assistant." } },
      FEATURE,
    );
    expect(p.grounding).toBe("strict");
    expect(p.groundingOptions?.persona).toBe("You are a claims assistant.");
  });
});

describe("grounding config — rejected shapes", () => {
  const bad = (grounding: unknown) => () =>
    cfg({ preset: "balanced" }, { f: { ...FEATURE, safety: { grounding } } });

  it("rejects a block with no mode", () => {
    expect(bad({ persona: "You are a claims assistant." })).toThrow(PolicyConfigError);
  });

  it("rejects an unknown citation field", () => {
    // Every field here is verified against the passage, so one the verifier
    // does not know how to compare must be a loud error, not a no-op.
    expect(bad({ mode: "strict", cite: ["paragraph"] })).toThrow(PolicyConfigError);
  });

  it("rejects an empty cite list", () => {
    // `cite: []` reads as "require citations" and means the opposite.
    expect(bad({ mode: "strict", cite: [] })).toThrow(PolicyConfigError);
  });

  it("rejects a misspelled key rather than dropping it", () => {
    expect(bad({ mode: "strict", persona_text: "x" })).toThrow(PolicyConfigError);
  });

  it("rejects an empty persona", () => {
    expect(bad({ mode: "strict", persona: "" })).toThrow(PolicyConfigError);
  });
});
