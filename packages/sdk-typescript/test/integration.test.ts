import { describe, expect, it, vi } from "vitest";
import { looksLikeSessionToken, warnUntrustedUserId } from "../src/integration";

describe("integration guardrails", () => {
  it("detects JWT-shaped user ids", () => {
    expect(looksLikeSessionToken("eyJhbGciOiJIUzI1NiJ9.payload.sig")).toBe(true);
    expect(looksLikeSessionToken("user_abc123")).toBe(false);
    expect(looksLikeSessionToken("sess_deadbeef")).toBe(true);
  });

  it("warns on suspicious userId", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnUntrustedUserId("eyJhbGciOiJIUzI1NiJ9.abc.def");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("session"));
    warn.mockRestore();
  });

  it("respects AI_GUARD_SDK_WARN_INTEGRATION=false", () => {
    const prev = process.env.AI_GUARD_SDK_WARN_INTEGRATION;
    process.env.AI_GUARD_SDK_WARN_INTEGRATION = "false";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnUntrustedUserId("eyJhbGciOiJIUzI1NiJ9.abc.def");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    if (prev === undefined) delete process.env.AI_GUARD_SDK_WARN_INTEGRATION;
    else process.env.AI_GUARD_SDK_WARN_INTEGRATION = prev;
  });
});
