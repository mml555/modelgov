import { describe, expect, it } from "vitest";
import { parseConfigObject } from "../src/config";
import { resolveSafetyPlan } from "../src/safety";
import { RAW_CONFIG } from "./helpers";

/** RAW_CONFIG with the global safety block and features overridden. */
function cfg(safety: unknown, features: Record<string, unknown>) {
  return parseConfigObject({ ...RAW_CONFIG, safety, features });
}

describe("resolveSafetyPlan — piiScope precedence", () => {
  it("a feature escalating to a stricter preset resets piiScope to that preset's default (not the global scope)", () => {
    // Global says 'mask output only'; a feature escalates to the strict preset,
    // which should tighten BOTH sides. Regression: piiScope used to stay 'output'.
    const config = cfg(
      { preset: "balanced", protect: { pii: "mask", pii_scope: "output", prompt_injection: "block" } },
      { f: { safety: "strict", model_class: "cheap", max_tokens: 100 } },
    );
    const plan = resolveSafetyPlan(config, config.features["f"]!);
    expect(plan.pii).toBe("block"); // strict preset escalates pii
    expect(plan.piiScope).toBe("both"); // ...and scope too
  });

  it("an explicit feature pii_scope still wins over the preset default", () => {
    const config = cfg(
      { preset: "balanced", protect: { pii: "mask", pii_scope: "both", prompt_injection: "block" } },
      { f: { safety: { preset: "strict", protect: { pii_scope: "output" } }, model_class: "cheap", max_tokens: 100 } },
    );
    const plan = resolveSafetyPlan(config, config.features["f"]!);
    expect(plan.piiScope).toBe("output");
  });

  it("falls back to the global explicit scope when the feature sets neither a preset nor a scope", () => {
    const config = cfg(
      { preset: "balanced", protect: { pii: "mask", pii_scope: "input", prompt_injection: "block" } },
      { f: { model_class: "cheap", max_tokens: 100 } },
    );
    const plan = resolveSafetyPlan(config, config.features["f"]!);
    expect(plan.piiScope).toBe("input");
  });

  it("defaults to 'both' when nothing sets a scope", () => {
    const config = cfg(
      { preset: "balanced", protect: { pii: "mask", prompt_injection: "block" } },
      { f: { model_class: "cheap", max_tokens: 100 } },
    );
    const plan = resolveSafetyPlan(config, config.features["f"]!);
    expect(plan.piiScope).toBe("both");
  });
});
