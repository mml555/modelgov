import { describe, expect, it } from "vitest";
import { stableStringify } from "../src/util/stableStringify";

describe("stableStringify", () => {
  it("sorts object keys deterministically", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("drops undefined object values", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("preserves array order", () => {
    expect(stableStringify([2, 1])).toBe("[2,1]");
  });
});
