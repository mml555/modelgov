import { describe, expect, it } from "vitest";
import { keyFormatWarning, parseSetupError } from "../src/setup/validation";

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

  it("ignores surrounding whitespace when checking the prefix", () => {
    expect(keyFormatWarning("OPENAI_API_KEY", "  sk-abc  ")).toBeNull();
  });

  it("names the field in plain words, not as an env var", () => {
    const warning = keyFormatWarning("OPENAI_API_KEY", "wrong") ?? "";
    expect(warning).toContain("openai api key");
    expect(warning).not.toContain("OPENAI_API_KEY");
  });
});

describe("parseSetupError", () => {
  it("unwraps the human message from a JSON error envelope", () => {
    const e = new Error(JSON.stringify({ error: { code: "invalid_request", message: "Bad key" } }));
    expect(parseSetupError(e)).toBe("Bad key");
  });

  it("falls back to the raw message when the body is not JSON", () => {
    expect(parseSetupError(new Error("network down"))).toBe("network down");
  });

  it("falls back to the raw message when JSON has no error.message", () => {
    expect(parseSetupError(new Error(JSON.stringify({ error: {} })))).toBe('{"error":{}}');
    expect(parseSetupError(new Error(JSON.stringify({ ok: true })))).toBe('{"ok":true}');
  });

  it("stringifies a non-Error rejection (never renders '[object Object]' blindly)", () => {
    expect(parseSetupError("plain string")).toBe("plain string");
    expect(parseSetupError(undefined)).toBe("undefined");
  });
});
