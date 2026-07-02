import { describe, expect, it } from "vitest";
import { deepDiff, diffConfigYaml } from "../src/modules/policy/diff";

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

  it("diffs two ai-guard.yaml docs on snake_case paths", () => {
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
