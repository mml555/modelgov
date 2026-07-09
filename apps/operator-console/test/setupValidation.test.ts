import { describe, expect, it } from "vitest";
import { keyFormatWarning } from "../src/setup/validation";

describe("keyFormatWarning", () => {
  it("returns null for empty or whitespace values (never nags on blank)", () => {
    expect(keyFormatWarning("OPENAI_API_KEY", "")).toBeNull();
    expect(keyFormatWarning("OPENAI_API_KEY", "   ")).toBeNull();
  });

  it("returns null for unknown keys (no prefix rule)", () => {
    expect(keyFormatWarning("SOME_CUSTOM_KEY", "whatever")).toBeNull();
  });

  it("returns null when the prefix matches", () => {
    expect(keyFormatWarning("OPENAI_API_KEY", "sk-abc123")).toBeNull();
    expect(keyFormatWarning("ANTHROPIC_API_KEY", "sk-ant-abc")).toBeNull();
    expect(keyFormatWarning("GROQ_API_KEY", "gsk_abc")).toBeNull();
  });

  it("warns when the prefix is clearly wrong", () => {
    expect(keyFormatWarning("OPENAI_API_KEY", "AIzaWrong")).toMatch(/doesn't look like/);
    expect(keyFormatWarning("ANTHROPIC_API_KEY", "sk-not-ant")).toMatch(/sk-ant-/);
  });

  it("accepts both AKIA and ASIA (temporary) AWS access keys", () => {
    expect(keyFormatWarning("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")).toBeNull();
    expect(keyFormatWarning("AWS_ACCESS_KEY_ID", "ASIAEXAMPLE")).toBeNull();
    expect(keyFormatWarning("AWS_ACCESS_KEY_ID", "nope")).toMatch(/doesn't look like/);
  });
});
