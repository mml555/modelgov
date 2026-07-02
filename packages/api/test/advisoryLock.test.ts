import { describe, expect, it, vi } from "vitest";
import { tryWithAdvisoryLock, withAdvisoryLock } from "../src/db/advisoryLock";

function mockClient(lockHeld = true) {
  const queries: string[] = [];
  return {
    queries,
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ ok: lockHeld }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

function mockPool(client: ReturnType<typeof mockClient>) {
  return {
    connect: vi.fn(async () => client),
  };
}

describe("withAdvisoryLock", () => {
  it("acquires the lock, runs fn, and releases on success", async () => {
    const client = mockClient();
    const pool = mockPool(client);
    const result = await withAdvisoryLock(pool as never, 42, async () => "ok");
    expect(result).toBe("ok");
    expect(client.query).toHaveBeenCalledWith("SELECT pg_advisory_lock($1)", [42]);
    expect(client.query).toHaveBeenCalledWith("SELECT pg_advisory_unlock($1)", [42]);
    expect(client.release).toHaveBeenCalled();
  });

  it("releases the lock when fn throws", async () => {
    const client = mockClient();
    const pool = mockPool(client);
    await expect(
      withAdvisoryLock(pool as never, 7, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(client.query).toHaveBeenCalledWith("SELECT pg_advisory_unlock($1)", [7]);
    expect(client.release).toHaveBeenCalled();
  });
});

describe("tryWithAdvisoryLock", () => {
  it("runs fn when the lock is acquired", async () => {
    const client = mockClient(true);
    const pool = mockPool(client);
    const fn = vi.fn(async () => {});
    const ran = await tryWithAdvisoryLock(pool as never, 99, fn);
    expect(ran).toBe(true);
    expect(fn).toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith("SELECT pg_advisory_unlock($1)", [99]);
  });

  it("skips fn when another holder has the lock", async () => {
    const client = mockClient(false);
    const pool = mockPool(client);
    const fn = vi.fn(async () => {});
    const ran = await tryWithAdvisoryLock(pool as never, 99, fn);
    expect(ran).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalledWith("SELECT pg_advisory_unlock($1)", [99]);
  });

  it("releases the lock when fn throws", async () => {
    const client = mockClient(true);
    const pool = mockPool(client);
    await expect(
      tryWithAdvisoryLock(pool as never, 1, async () => {
        throw new Error("sweep failed");
      }),
    ).rejects.toThrow("sweep failed");
    expect(client.query).toHaveBeenCalledWith("SELECT pg_advisory_unlock($1)", [1]);
  });
});
