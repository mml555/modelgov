import { describe, expect, it } from "vitest";
import { isDatabaseUnavailableError } from "../src/util/dbUnavailable";

// A Postgres restart/failover is transient and retryable; a generic 500 tells
// clients NOT to retry and points on-call at a code defect. This classifier is
// what turns that into 503 `database_unavailable`. Its risk is OVER-matching —
// misfiling a real query bug as "retry later" would hide it — so the negative
// cases below matter at least as much as the positive ones.

describe("isDatabaseUnavailableError — connection failures (retryable)", () => {
  it("matches pg SQLSTATEs for a server that went away", () => {
    for (const code of ["08000", "08001", "08003", "08004", "08006", "57P01", "57P02", "57P03"]) {
      expect(isDatabaseUnavailableError({ code }), code).toBe(true);
    }
  });

  it("matches socket-level errnos", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ETIMEDOUT"]) {
      expect(isDatabaseUnavailableError({ code }), code).toBe(true);
    }
  });

  it("matches node-pg's message-only failures", () => {
    // These arrive as a plain Error with no code — notably a pool checkout
    // timeout and a socket the server closed mid-query.
    for (const message of [
      "Connection terminated unexpectedly",
      "timeout exceeded when trying to connect",
      "Client has encountered a connection error and is not queryable",
      "terminating connection due to administrator command",
      "server closed the connection unexpectedly",
    ]) {
      expect(isDatabaseUnavailableError(new Error(message)), message).toBe(true);
    }
  });

  it("unwraps a nested cause", () => {
    const wrapped = new Error("query failed", { cause: { code: "ECONNREFUSED" } });
    expect(isDatabaseUnavailableError(wrapped)).toBe(true);
  });

  it("is case-insensitive on messages", () => {
    expect(isDatabaseUnavailableError(new Error("CONNECTION TERMINATED"))).toBe(true);
  });
});

describe("isDatabaseUnavailableError — real bugs must stay 500", () => {
  it("does NOT match constraint / data errors", () => {
    for (const code of [
      "23505", // unique_violation
      "23503", // foreign_key_violation
      "23502", // not_null_violation
      "22P02", // invalid_text_representation
      "42601", // syntax_error
      "42P01", // undefined_table
      "42703", // undefined_column
    ]) {
      expect(isDatabaseUnavailableError({ code }), code).toBe(false);
    }
  });

  it("does NOT match a statement timeout or deadlock", () => {
    // Slow/contended queries are a real problem to surface, not to retry away.
    expect(isDatabaseUnavailableError({ code: "57014" })).toBe(false); // query_canceled
    expect(isDatabaseUnavailableError({ code: "40P01" })).toBe(false); // deadlock_detected
    expect(isDatabaseUnavailableError({ code: "55P03" })).toBe(false); // lock_not_available
  });

  it("does NOT match ordinary application errors", () => {
    expect(isDatabaseUnavailableError(new Error("something broke"))).toBe(false);
    expect(isDatabaseUnavailableError(new TypeError("x is not a function"))).toBe(false);
  });

  it("handles non-error inputs without throwing", () => {
    for (const v of [null, undefined, "ECONNREFUSED", 42, []]) {
      expect(isDatabaseUnavailableError(v)).toBe(false);
    }
  });

  it("terminates on a self-referential cause", () => {
    const e: { message: string; cause?: unknown } = { message: "boom" };
    e.cause = e;
    expect(isDatabaseUnavailableError(e)).toBe(false);
  });
});
