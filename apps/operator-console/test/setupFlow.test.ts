import { describe, expect, it } from "vitest";
import { backStep, getVisibleSteps, nextStep } from "../src/setup/flow";

describe("getVisibleSteps", () => {
  it("hides provider/key steps for the demo backend", () => {
    const ids = getVisibleSteps("demo", false).map((s) => s.id);
    expect(ids).not.toContain("providers");
    expect(ids).not.toContain("keys");
    expect(ids).toContain("limits");
  });

  it("shows provider/key steps only for cloud", () => {
    const ids = getVisibleSteps("cloud", false).map((s) => s.id);
    expect(ids).toContain("providers");
    expect(ids).toContain("keys");
  });

  it("hides the backend step for a local-only template", () => {
    const ids = getVisibleSteps("local", true).map((s) => s.id);
    expect(ids).not.toContain("backend");
    expect(ids).not.toContain("providers");
  });
});

describe("nextStep", () => {
  it("cloud goes template → backend → providers → keys → limits", () => {
    const opts = { backend: "cloud" as const, templateLocalOnly: false };
    expect(nextStep("template", opts)).toBe("backend");
    expect(nextStep("backend", opts)).toBe("providers");
    expect(nextStep("providers", opts)).toBe("keys");
    expect(nextStep("keys", opts)).toBe("limits");
  });

  it("demo skips providers/keys: backend → limits", () => {
    expect(nextStep("backend", { backend: "demo", templateLocalOnly: false })).toBe("limits");
  });

  it("local-only template skips the backend step: template → limits", () => {
    expect(nextStep("template", { backend: "local", templateLocalOnly: true })).toBe("limits");
  });
});

describe("backStep", () => {
  const base = { backend: "cloud" as const, templateLocalOnly: false, quickStart: false };

  it("quick-start jumps review → welcome", () => {
    expect(backStep("review", { ...base, quickStart: true })).toBe("welcome");
  });

  it("limits goes back to keys for cloud", () => {
    expect(backStep("limits", base)).toBe("keys");
  });

  it("limits goes back to backend for demo (no key steps)", () => {
    expect(backStep("limits", { backend: "demo", templateLocalOnly: false, quickStart: false })).toBe("backend");
  });

  it("limits goes back to template for a local-only template", () => {
    expect(backStep("limits", { backend: "local", templateLocalOnly: true, quickStart: false })).toBe("template");
  });
});
