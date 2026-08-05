import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { assertPoolReachable, createPool, withTransaction } from "../src/db/pool";

// The pool's `'error'` handler is documented as MANDATORY: node-pg emits 'error'
// on idle clients when the server drops them (failover/restart), and an unhandled
// EventEmitter 'error' takes down the process. Nothing asserted that the default
// handler is actually installed, so a refactor could drop it and only production
// failover would find out.

// Syntactically valid but never connected to — Pool construction is lazy, and no
// test here issues a query against it.
const UNREACHABLE = "postgres://postgres:postgres@127.0.0.1:1/nonexistent";

describe("createPool error handling", () => {
  const pools: Pool[] = [];
  afterEach(async () => {
    for (const p of pools.splice(0)) await p.end().catch(() => {});
    vi.restoreAllMocks();
  });

  it("installs a default idle-client error handler that does not rethrow", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = createPool(UNREACHABLE);
    pools.push(pool);

    // Without a listener this emit would throw (unhandled 'error').
    expect(() => pool.emit("error", new Error("connection terminated"))).not.toThrow();
    expect(spy).toHaveBeenCalledWith("postgres idle client error", expect.any(Error));
  });

  it("routes idle-client errors to a caller-supplied handler instead", () => {
    const onError = vi.fn();
    const pool = createPool(UNREACHABLE, { onError });
    pools.push(pool);

    const err = new Error("failover");
    pool.emit("error", err);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it("has at least one 'error' listener (no unhandled-error crash path)", () => {
    const pool = createPool(UNREACHABLE);
    pools.push(pool);
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
  });
});

describe("assertPoolReachable", () => {
  it("resolves when the probe query succeeds", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [{}] })) } as unknown as Pool;
    await expect(assertPoolReachable(pool)).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledWith("SELECT 1");
  });

  it("propagates the connection failure so boot can fail fast", async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    } as unknown as Pool;
    await expect(assertPoolReachable(pool)).rejects.toThrow("ECONNREFUSED");
  });
});

describe("withTransaction rollback path", () => {
  function fakePool(failOn?: string) {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (failOn && sql.includes(failOn)) throw new Error(`${failOn} failed`);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    return { pool: { connect: vi.fn(async () => client) } as unknown as Pool, client, calls };
  }

  it("COMMITs and releases on success", async () => {
    const { pool, client, calls } = fakePool();
    await expect(withTransaction(pool, async () => "value")).resolves.toBe("value");
    expect(calls).toContain("BEGIN");
    expect(calls).toContain("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("ROLLBACKs, releases, and rethrows when the body throws", async () => {
    const { pool, client, calls } = fakePool();
    await expect(
      withTransaction(pool, async () => {
        throw new Error("constraint violation");
      }),
    ).rejects.toThrow("constraint violation");
    expect(calls).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("reports the ORIGINAL error even when the ROLLBACK itself fails", async () => {
    // A dropped connection makes ROLLBACK fail too; surfacing that would hide the
    // real cause, so it is deliberately swallowed.
    const { pool, client } = fakePool("ROLLBACK");
    await expect(
      withTransaction(pool, async () => {
        throw new Error("real cause");
      }),
    ).rejects.toThrow("real cause");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("sets a transaction-scoped lock_timeout when asked", async () => {
    const { pool, client } = fakePool();
    await withTransaction(pool, async () => undefined, { lockTimeoutMs: 2500 });
    expect(client.query).toHaveBeenCalledWith(
      "SELECT set_config('lock_timeout', $1, true)",
      ["2500"],
    );
  });

  it("floors a fractional lock timeout (Postgres wants whole milliseconds)", async () => {
    const { pool, client } = fakePool();
    await withTransaction(pool, async () => undefined, { lockTimeoutMs: 99.9 });
    expect(client.query).toHaveBeenCalledWith(
      "SELECT set_config('lock_timeout', $1, true)",
      ["99"],
    );
  });

  it("omits the lock timeout entirely when not requested", async () => {
    const { pool, calls } = fakePool();
    await withTransaction(pool, async () => undefined);
    expect(calls.some((s) => s.includes("lock_timeout"))).toBe(false);
  });
});
