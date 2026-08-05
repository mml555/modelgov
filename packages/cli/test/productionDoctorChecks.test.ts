import { describe, expect, it } from "vitest";
import { MIN_PRODUCTION_SECRET_LENGTH } from "@modelgov/policy-engine";
import { productionDoctorChecksFromEnv } from "../src/productionDoctorChecks.js";

// `modelgov doctor production` is the last gate before a real deploy, so the
// mapping from env to fail/warn/pass is asserted by code, not by eyeballing
// output. Tests target codes (stable contract) rather than message wording.

// Long AND high-entropy: isWeakSecret also rejects filler like "xxxx…" (/^x+$/i),
// so a repeated-character string of legal length is still correctly weak.
const STRONG = "k7Qm2vT9pLr4Zx8Ns3Wd6Yb1Fh5Jc0Ag";

function codes(env: Record<string, string>) {
  return productionDoctorChecksFromEnv(env).map((c) => `${c.severity}:${c.code}`);
}
function find(env: Record<string, string>, code: string) {
  return productionDoctorChecksFromEnv(env).find((c) => c.code === code);
}

describe("test fixture", () => {
  it("STRONG clears the production secret-length bar", () => {
    // Pinned to the constant so a future bump doesn't silently make the
    // "passes a strong key" test assert the wrong thing.
    expect(STRONG.length).toBeGreaterThanOrEqual(MIN_PRODUCTION_SECRET_LENGTH);
  });
});

describe("productionDoctorChecksFromEnv — production mode", () => {
  it("warns when MODELGOV_PRODUCTION is not true", () => {
    expect(codes({})).toContain("warn:production_mode");
    expect(codes({ MODELGOV_PRODUCTION: "false" })).toContain("warn:production_mode");
    // Only the exact string counts — "1"/"TRUE" must not pass for a boot flag.
    expect(codes({ MODELGOV_PRODUCTION: "1" })).toContain("warn:production_mode");
    expect(codes({ MODELGOV_PRODUCTION: "TRUE" })).toContain("warn:production_mode");
  });

  it("stops warning once production mode is on", () => {
    expect(codes({ MODELGOV_PRODUCTION: "true" })).not.toContain("warn:production_mode");
  });

  it("offers an actionable fix, not just a complaint", () => {
    expect(find({}, "production_mode")?.fix).toMatch(/MODELGOV_PRODUCTION=true/);
  });
});

describe("productionDoctorChecksFromEnv — API key posture", () => {
  it("FAILS on a known dev default key", () => {
    expect(codes({ MODELGOV_API_KEY: "sk-modelgov-api-local" })).toContain("fail:dev_api_key");
    expect(codes({ MODELGOV_API_KEY: "smoke-test-key" })).toContain("fail:dev_api_key");
  });

  it("FAILS on a key that is merely too short", () => {
    const c = codes({ MODELGOV_API_KEY: "short" });
    expect(c).toContain("fail:weak_api_key");
    expect(c).not.toContain("fail:dev_api_key");
  });

  it("passes a strong, non-default key", () => {
    const c = codes({ MODELGOV_API_KEY: STRONG });
    expect(c).toContain("pass:api_key");
    expect(c).not.toContain("fail:weak_api_key");
  });

  it("says nothing about the API key when it is unset (the boot guard owns that)", () => {
    const c = codes({});
    expect(c.some((x) => x.endsWith(":api_key"))).toBe(false);
    expect(c).not.toContain("fail:weak_api_key");
    expect(c).not.toContain("fail:dev_api_key");
  });

  it("reports a dev default as dev_api_key even though it is also weak", () => {
    // Ordering matters: the dev-default message names the actual problem.
    const forKey = productionDoctorChecksFromEnv({ MODELGOV_API_KEY: "sk-modelgov-api-local" })
      .filter((c) => c.code === "dev_api_key" || c.code === "weak_api_key");
    expect(forKey).toHaveLength(1);
    expect(forKey[0]?.code).toBe("dev_api_key");
  });
});

describe("productionDoctorChecksFromEnv — advisory warnings", () => {
  it("warns when rate limits fail open", () => {
    expect(codes({ RATE_LIMIT_FAIL_OPEN: "true" })).toContain("warn:rate_limit_fail_open");
    expect(codes({ RATE_LIMIT_FAIL_OPEN: "false" })).not.toContain("warn:rate_limit_fail_open");
  });

  it("warns about a missing REDIS_URL only in production mode", () => {
    expect(codes({ MODELGOV_PRODUCTION: "true" })).toContain("warn:redis");
    // Not in production: a missing Redis is expected, so don't cry wolf.
    expect(codes({})).not.toContain("warn:redis");
  });

  it("stops warning once REDIS_URL is configured", () => {
    expect(
      codes({ MODELGOV_PRODUCTION: "true", REDIS_URL: "redis://cache:6379" }),
    ).not.toContain("warn:redis");
  });
});

describe("productionDoctorChecksFromEnv — shape", () => {
  it("includes the shared boot-guard posture checks, not only doctor-local ones", () => {
    // productionPostureChecks contributes codes the doctor never pushes itself;
    // if that call were dropped, doctor would silently stop checking them.
    const localOnly = new Set([
      "production_mode",
      "dev_api_key",
      "weak_api_key",
      "api_key",
      "rate_limit_fail_open",
      "redis",
    ]);
    const shared = productionDoctorChecksFromEnv({ MODELGOV_PRODUCTION: "true" }).filter(
      (c) => !localOnly.has(c.code),
    );
    expect(shared.length).toBeGreaterThan(0);
  });

  it("returns only valid severities and non-empty codes/messages", () => {
    const all = productionDoctorChecksFromEnv({
      MODELGOV_PRODUCTION: "true",
      MODELGOV_API_KEY: STRONG,
      RATE_LIMIT_FAIL_OPEN: "true",
    });
    expect(all.length).toBeGreaterThan(0);
    for (const c of all) {
      expect(["fail", "warn", "pass"]).toContain(c.severity);
      expect(c.code.length).toBeGreaterThan(0);
      expect(c.message.length).toBeGreaterThan(0);
    }
  });

  it("is a pure function of its env argument (no process.env leakage)", () => {
    const before = productionDoctorChecksFromEnv({});
    process.env.MODELGOV_PRODUCTION = "true";
    try {
      expect(productionDoctorChecksFromEnv({})).toEqual(before);
    } finally {
      delete process.env.MODELGOV_PRODUCTION;
    }
  });
});
