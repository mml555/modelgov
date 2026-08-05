import { describe, expect, it } from "vitest";
import { isMode, isRealSecret, parseJson, rerunCommand } from "../src/ops.js";

describe("isMode", () => {
  it("accepts every shipped deploy mode", () => {
    for (const m of ["simple", "full", "local", "cloud", "azure", "prod"]) {
      expect(isMode(m), m).toBe(true);
    }
  });

  it("rejects anything else, including near-misses and casing", () => {
    for (const m of ["", "Simple", "production", "dev", "--yes", "up"]) {
      expect(isMode(m), m).toBe(false);
    }
  });
});

// A placeholder mistaken for a real credential is how `make start-cloud` used to
// boot on the demo .env and then 401 against the provider — the failure surfaced
// far from its cause, so each denied shape is pinned here.
describe("isRealSecret", () => {
  it("accepts a plausible real key", () => {
    expect(isRealSecret("sk-abcdefghijklmnop")).toBe(true);
    expect(isRealSecret("AIzaSyD-Example-Key-Value")).toBe(true);
  });

  it("rejects missing or empty values", () => {
    expect(isRealSecret(undefined)).toBe(false);
    expect(isRealSecret("")).toBe(false);
    expect(isRealSecret("      ")).toBe(false);
  });

  it("rejects values too short to be a credential", () => {
    expect(isRealSecret("abc")).toBe(false);
    expect(isRealSecret("123456")).toBe(false); // exactly 6 — still too short
    expect(isRealSecret("1234567")).toBe(true); // 7 clears the bar
  });

  it("rejects the shipped .env placeholders", () => {
    // These are >6 chars and contain no "..."/"REPLACE", so only the explicit
    // denylist stops them.
    for (const p of ["demo-unused", "demo-key", "changeme", "your-key-here"]) {
      expect(isRealSecret(p), p).toBe(false);
    }
  });

  it("rejects elided and REPLACE-me templates", () => {
    expect(isRealSecret("sk-...")).toBe(false);
    expect(isRealSecret("sk-REPLACE_ME")).toBe(false);
  });

  it("rejects angle-bracket scaffold hints", () => {
    expect(isRealSecret("https://<resource>.openai.azure.com")).toBe(false);
  });

  it("rejects /path/to/ example paths", () => {
    expect(isRealSecret("/path/to/service-account.json")).toBe(false);
    // A real absolute path elsewhere is fine.
    expect(isRealSecret("/secrets/vertex-sa.json")).toBe(true);
  });

  it("trims before judging, so a padded placeholder is still rejected", () => {
    expect(isRealSecret("  demo-unused  ")).toBe(false);
    expect(isRealSecret("  sk-realkeyvalue  ")).toBe(true);
  });
});

describe("rerunCommand", () => {
  it("maps a bare mode to its make target", () => {
    expect(rerunCommand("simple")).toBe("make start");
    expect(rerunCommand("full")).toBe("make start-full");
    expect(rerunCommand("local")).toBe("make start-local");
    expect(rerunCommand("cloud")).toBe("make start-cloud");
    expect(rerunCommand("azure")).toBe("make start-azure");
    expect(rerunCommand("prod")).toBe("make up-prod");
  });

  it("maps reload-providers to the pnpm CLI (it has no make target)", () => {
    expect(rerunCommand("reload-providers")).toBe("pnpm modelgov reload-providers");
  });

  it("suffixes up/down with the mode, except the default simple", () => {
    expect(rerunCommand("up", "simple")).toBe("make start");
    expect(rerunCommand("up", "cloud")).toBe("make start-cloud");
    expect(rerunCommand("down", "simple")).toBe("make stop");
    expect(rerunCommand("down", "local")).toBe("make stop-local");
  });

  it("suffixes other commands with the mode", () => {
    expect(rerunCommand("doctor", "cloud")).toBe("make doctor-cloud");
    expect(rerunCommand("status", "simple")).toBe("make status");
    expect(rerunCommand("smoke")).toBe("make smoke");
  });
});

describe("parseJson", () => {
  it("returns the parsed object", () => {
    expect(parseJson('{"ok":true}')).toEqual({ ok: true });
  });

  it("returns undefined for malformed JSON instead of throwing", () => {
    expect(parseJson("not json")).toBeUndefined();
    expect(parseJson("")).toBeUndefined();
  });

  it("returns undefined for valid JSON that isn't an object", () => {
    // A bare scalar or null would break property access downstream.
    expect(parseJson("null")).toBeUndefined();
    expect(parseJson("42")).toBeUndefined();
    expect(parseJson('"a string"')).toBeUndefined();
  });

  it("passes arrays through (typeof 'object')", () => {
    expect(parseJson("[1,2]")).toEqual([1, 2]);
  });
});
