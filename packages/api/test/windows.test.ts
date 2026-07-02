import { describe, expect, it } from "vitest";
import { dayWindowStart, monthWindowStart } from "../src/services/windows";

describe("budget windows (UTC)", () => {
  it("buckets by UTC day", () => {
    expect(dayWindowStart(new Date("2026-06-30T23:59:59Z"))).toBe("2026-06-30");
    expect(dayWindowStart(new Date("2026-07-01T00:00:01Z"))).toBe("2026-07-01");
  });

  it("buckets by first-of-month", () => {
    expect(monthWindowStart(new Date("2026-06-30T23:59:59Z"))).toBe("2026-06-01");
    expect(monthWindowStart(new Date("2026-12-15T12:00:00Z"))).toBe("2026-12-01");
  });
});
