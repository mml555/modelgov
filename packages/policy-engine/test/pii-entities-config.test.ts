import { describe, expect, it } from "vitest";
import { parseConfigObject } from "../src/config";
import { resolveSafetyPlan } from "../src/safety";
import { PolicyConfigError } from "../src/types";
import { RAW_CONFIG } from "./helpers";

function cfg(safety: unknown, features: Record<string, unknown>) {
  return parseConfigObject({ ...RAW_CONFIG, safety, features });
}

const plan = (safety: unknown, feature: unknown) => {
  const config = cfg(safety, { f: feature });
  return resolveSafetyPlan(config, config.features["f"]!);
};

const FEATURE = { model_class: "cheap", max_tokens: 100 };

describe("pii config — the string form is unchanged", () => {
  it("still accepts a bare mode and sets no entity policy", () => {
    const p = plan({ preset: "custom" }, { ...FEATURE, safety: { protect: { pii: "mask" } } });
    expect(p.pii).toBe("mask");
    expect(p.piiEntities).toBeUndefined();
  });
});

describe("pii config — the per-entity form", () => {
  it("resolves the coarse mode to mask when nothing can block", () => {
    const p = plan(
      { preset: "custom" },
      { ...FEATURE, safety: { protect: { pii: { allow: ["PERSON"], default: "mask" } } } },
    );
    expect(p.pii).toBe("mask");
    expect(p.piiEntities).toEqual({ allow: ["PERSON"], default: "mask" });
  });

  it("resolves the coarse mode to block when any entity may block", () => {
    // Conservative on purpose: the coarse mode gates things like refusing an
    // image that cannot be scanned, and those must assume the strictest outcome.
    const p = plan(
      { preset: "custom" },
      { ...FEATURE, safety: { protect: { pii: { block: ["US_SSN"], default: "allow" } } } },
    );
    expect(p.pii).toBe("block");
  });

  it("treats `default: block` as blocking too", () => {
    const p = plan(
      { preset: "custom" },
      { ...FEATURE, safety: { protect: { pii: { allow: ["PERSON"], default: "block" } } } },
    );
    expect(p.pii).toBe("block");
  });

  it("defaults the default to mask", () => {
    const p = plan(
      { preset: "custom" },
      { ...FEATURE, safety: { protect: { pii: { allow: ["PERSON"] } } } },
    );
    expect(p.piiEntities?.default).toBe("mask");
  });

  it("inherits a global entity policy when the feature says nothing", () => {
    const p = plan(
      { preset: "custom", protect: { pii: { allow: ["PERSON"], default: "mask" } } },
      FEATURE,
    );
    expect(p.piiEntities?.allow).toEqual(["PERSON"]);
  });

  it("CLEARS the global entity policy when a feature asks for a blanket mode", () => {
    // The mode and the entity policy resolve as one unit. Resolving them
    // independently would leave a feature whose author wrote `pii: mask` still
    // passing PERSON through, inherited from a global policy they never saw.
    const p = plan(
      { preset: "custom", protect: { pii: { allow: ["PERSON"], default: "mask" } } },
      { ...FEATURE, safety: { protect: { pii: "mask" } } },
    );
    expect(p.pii).toBe("mask");
    expect(p.piiEntities).toBeUndefined();
  });

  it("clears it when the feature escalates to a stricter preset", () => {
    const p = plan(
      { preset: "custom", protect: { pii: { allow: ["PERSON"], default: "mask" } } },
      { ...FEATURE, safety: "strict" },
    );
    expect(p.pii).toBe("block");
    expect(p.piiEntities).toBeUndefined();
  });
});

describe("pii config — rejected shapes", () => {
  const bad = (pii: unknown) => () =>
    cfg({ preset: "custom" }, { f: { ...FEATURE, safety: { protect: { pii } } } });

  it("rejects an entity in two lists rather than inventing a precedence rule", () => {
    expect(bad({ mask: ["PERSON"], allow: ["PERSON"] })).toThrow(PolicyConfigError);
  });

  it("rejects a block that names no entities at all", () => {
    expect(bad({ default: "mask" })).toThrow(PolicyConfigError);
  });

  it("rejects a lower-case entity name (almost always a typo)", () => {
    expect(bad({ allow: ["person"] })).toThrow(PolicyConfigError);
  });

  it("rejects an empty list, which reads as a policy but is not one", () => {
    expect(bad({ allow: [] })).toThrow(PolicyConfigError);
  });

  it("rejects an unknown key rather than dropping it", () => {
    expect(bad({ allow: ["PERSON"], redact: ["US_SSN"] })).toThrow(PolicyConfigError);
  });

  it("accepts an unrecognised but well-formed entity name (custom recognizers)", () => {
    // Presidio deployments register their own; a closed enum would reject valid
    // config and force every new recognizer through a gateway release.
    expect(bad({ allow: ["POLICY_NUMBER"] })).not.toThrow();
  });
});
