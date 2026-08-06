import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertTestDatabase, UnsafeTestDatabaseError } from "./assertTestDatabase";

// The test suite TRUNCATEs every table in `public` before each file, against
// whatever DATABASE_URL holds. This guard is the only thing standing between a
// stale shell export and someone's dev database.

const OVERRIDE = "MODELGOV_ALLOW_DESTRUCTIVE_TEST_DB";

// The override is a legitimate way to RUN this suite, so it may already be set
// in the environment. Clearing it unconditionally would strip it for every test
// file that runs after this one — breaking setup.ts's guard for the rest of the
// run. Capture, clear for isolation, restore.
const priorOverride = process.env[OVERRIDE];

beforeEach(() => {
  delete process.env[OVERRIDE];
});
afterEach(() => {
  if (priorOverride === undefined) delete process.env[OVERRIDE];
  else process.env[OVERRIDE] = priorOverride;
});

describe("assertTestDatabase — allows the repo's own throwaway databases", () => {
  it("allows the disposable container's default port", () => {
    // scripts/test-with-db.sh
    expect(() =>
      assertTestDatabase("postgres://postgres:postgres@localhost:55433/modelgov"),
    ).not.toThrow();
  });

  it("allows the CI service container", () => {
    expect(() =>
      assertTestDatabase("postgres://postgres:postgres@localhost:55432/modelgov"),
    ).not.toThrow();
  });

  it("allows an AIGUARD_TEST_PG_PORT override", () => {
    expect(() =>
      assertTestDatabase("postgres://postgres:postgres@127.0.0.1:55437/modelgov"),
    ).not.toThrow();
  });
});

describe("assertTestDatabase — refuses anything that might be real", () => {
  const refuses = (url: string) => {
    expect(() => assertTestDatabase(url)).toThrow(UnsafeTestDatabaseError);
  };

  it("refuses a remote host", () => {
    refuses("postgres://user:pw@db.internal.example.com:55433/modelgov");
  });

  it("refuses the default Postgres port even on loopback", () => {
    // The overwhelmingly likely local dev database.
    refuses("postgres://postgres:postgres@localhost:5432/modelgov");
  });

  it("refuses a port-less URL, which means 5432", () => {
    refuses("postgres://postgres:postgres@localhost/modelgov");
  });

  it("refuses a remote host on the default port and says both reasons", () => {
    try {
      assertTestDatabase("postgres://u:p@prod.example.com/modelgov");
      throw new Error("expected a refusal");
    } catch (e) {
      expect(String(e)).toMatch(/not loopback/);
      expect(String(e)).toMatch(/default Postgres port/);
    }
  });

  it("refuses an unparseable URL rather than assuming it is safe", () => {
    // Cannot be shown safe, so it is not treated as safe.
    refuses("not a url");
  });

  it("names the safe alternative in the message", () => {
    // A guard that only says "no" gets disabled; this one has to be actionable.
    try {
      assertTestDatabase("postgres://postgres:postgres@localhost:5432/modelgov");
      throw new Error("expected a refusal");
    } catch (e) {
      expect(String(e)).toMatch(/pnpm test/);
      expect(String(e)).toMatch(/AIGUARD_TEST_PG_PORT/);
      expect(String(e)).toContain(OVERRIDE);
    }
  });
});

describe("assertTestDatabase — the escape hatch", () => {
  it("allows anything when the override is set to exactly 1", () => {
    process.env[OVERRIDE] = "1";
    expect(() => assertTestDatabase("postgres://u:p@prod.example.com/modelgov")).not.toThrow();
  });

  it("is not fooled by a truthy-but-not-1 value", () => {
    // "0", "false", "" must not disable a destructive-action guard by accident.
    for (const v of ["0", "false", "true", "yes", ""]) {
      process.env[OVERRIDE] = v;
      expect(() => assertTestDatabase("postgres://u:p@prod.example.com/db")).toThrow();
    }
  });
});
