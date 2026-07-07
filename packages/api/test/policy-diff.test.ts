import { describe, expect, it } from "vitest";
import { deepDiff, diffConfigYaml } from "../src/modules/policy/diff";
import { frozenPolicyFieldsFingerprint } from "../src/modules/policy/repo";
import { parseConfigObject } from "@modelgov/policy-engine";

describe("frozenPolicyFieldsFingerprint (H1 hot-reload guard)", () => {
  const base = {
    project: { name: "t", environment: "test" },
    budgets: {
      global: { monthly_usd: 1, hard_stop_at_percent: 100 },
      by_user_type: { logged_in: { daily_usd: 1, daily_requests: 1, models: ["cheap"] } },
    },
    features: { f: { model_class: "cheap", max_tokens: 1, safety: "dev" } },
    model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
    safety: { preset: "dev" },
    pricing: { "openai/gpt-4o-mini": { input_per_1k: 0.001, output_per_1k: 0.002 } },
  };

  it("is stable for configs that differ only in hot-reloadable fields", () => {
    const a = parseConfigObject(base);
    // Change a budget cap (hot-reloadable) — the frozen fingerprint must NOT change.
    const b = parseConfigObject({
      ...base,
      budgets: { ...base.budgets, global: { monthly_usd: 999, hard_stop_at_percent: 100 } },
    });
    expect(frozenPolicyFieldsFingerprint(a)).toBe(frozenPolicyFieldsFingerprint(b));
  });

  it("changes when a boot-only field (pricing) changes", () => {
    const a = parseConfigObject(base);
    const b = parseConfigObject({
      ...base,
      pricing: { "openai/gpt-4o-mini": { input_per_1k: 0.999, output_per_1k: 0.002 } },
    });
    expect(frozenPolicyFieldsFingerprint(a)).not.toBe(frozenPolicyFieldsFingerprint(b));
  });
});

describe("deepDiff", () => {
  it("reports changed, added, and removed leaves by path", () => {
    const from = { a: 1, b: { c: 2, d: 3 }, e: 4 };
    const to = { a: 1, b: { c: 9, f: 5 }, g: 6 };
    const diff = deepDiff(from, to);
    const byPath = Object.fromEntries(diff.map((e) => [e.path, e]));
    expect(byPath["b.c"]).toEqual({ path: "b.c", from: 2, to: 9 });
    expect(byPath["b.d"]).toEqual({ path: "b.d", from: 3, to: undefined }); // removed
    expect(byPath["b.f"]).toEqual({ path: "b.f", from: undefined, to: 5 }); // added
    expect(byPath["e"]?.to).toBeUndefined();
    expect(byPath["g"]?.from).toBeUndefined();
    expect(byPath["a"]).toBeUndefined(); // unchanged → not in diff
  });

  it("treats arrays as leaves", () => {
    expect(deepDiff({ m: ["cheap"] }, { m: ["cheap", "standard"] })).toEqual([
      { path: "m", from: ["cheap"], to: ["cheap", "standard"] },
    ]);
  });

  it("diffs two modelgov.yaml docs on snake_case paths", () => {
    const a = "budgets:\n  global:\n    monthly_usd: 100\n";
    const b = "budgets:\n  global:\n    monthly_usd: 250\n";
    expect(diffConfigYaml(a, b)).toEqual([
      { path: "budgets.global.monthly_usd", from: 100, to: 250 },
    ]);
  });

  it("empty diff for identical configs", () => {
    const y = "project:\n  name: t\n";
    expect(diffConfigYaml(y, y)).toEqual([]);
  });
});
