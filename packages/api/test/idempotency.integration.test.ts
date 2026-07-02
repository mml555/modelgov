import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import { claimKey, completeKey, releaseKey, cleanupCompletedIdempotencyKeys } from "../src/modules/idempotency/repo";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("idempotency repo (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE idempotency_keys");
  });

  const params = { key: "k1", userId: "u1", requestHash: "h1" };

  it("first claim wins; the second sees a 'processing' conflict", async () => {
    const a = await claimKey(pool, params);
    const b = await claimKey(pool, params);
    expect(a.state).toBe("claimed");
    expect(b.state).toBe("conflict");
    if (b.state === "conflict") {
      expect(b.existing.status).toBe("processing");
      expect(b.existing.requestHash).toBe("h1");
    }
  });

  it("after completion, a conflicting claim returns the stored response", async () => {
    await claimKey(pool, params);
    await completeKey(pool, {
      userId: "u1",
      key: "k1",
      responseStatus: 200,
      responseBody: { ok: true, body: { model: "m" } },
    });
    const again = await claimKey(pool, params);
    expect(again.state).toBe("conflict");
    if (again.state === "conflict") {
      expect(again.existing.status).toBe("completed");
      expect(again.existing.responseStatus).toBe(200);
      expect(again.existing.responseBody).toEqual({ ok: true, body: { model: "m" } });
    }
  });

  it("does not collide or replay across tenants sharing (userId, key)", async () => {
    // Tenant A claims and completes with its own response.
    await claimKey(pool, { ...params, tenantId: "tenant-a" });
    await completeKey(pool, {
      userId: "u1",
      key: "k1",
      responseStatus: 200,
      responseBody: { ok: true, body: { secret: "A-only" } },
      tenantId: "tenant-a",
    });
    // Tenant B with the SAME userId + key must claim fresh (no collision) and
    // never see tenant A's cached body.
    const b = await claimKey(pool, { ...params, tenantId: "tenant-b" });
    expect(b.state).toBe("claimed");
    // And A can still replay its own — unaffected by B's claim.
    const aAgain = await claimKey(pool, { ...params, tenantId: "tenant-a" });
    expect(aAgain.state).toBe("conflict");
    if (aAgain.state === "conflict") {
      expect(aAgain.existing.responseBody).toEqual({ ok: true, body: { secret: "A-only" } });
    }
  });

  it("only one of many concurrent claims wins", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimKey(pool, params)),
    );
    expect(results.filter((r) => r.state === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.state === "conflict")).toHaveLength(9);
  });

  it("release lets a fresh claim win again", async () => {
    await claimKey(pool, params);
    await releaseKey(pool, { userId: "u1", key: "k1" });
    const again = await claimKey(pool, params);
    expect(again.state).toBe("claimed");
  });

  it("scopes keys per user — same key string, different users", async () => {
    const a = await claimKey(pool, { key: "shared", userId: "u1", requestHash: "h1" });
    const b = await claimKey(pool, { key: "shared", userId: "u2", requestHash: "h1" });
    expect(a.state).toBe("claimed");
    expect(b.state).toBe("claimed");
  });

  it("cleanupCompletedIdempotencyKeys prunes old completed rows", async () => {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    await claimKey(pool, params);
    await completeKey(pool, {
      userId: "u1",
      key: "k1",
      responseStatus: 200,
      responseBody: { ok: true },
    });
    await pool.query(
      `UPDATE idempotency_keys SET completed_at = $1::timestamptz WHERE user_id = $2 AND key = $3`,
      [new Date(now - sevenDaysMs - 60_000).toISOString(), "u1", "k1"],
    );

    expect(await cleanupCompletedIdempotencyKeys(pool, sevenDaysMs, now)).toBe(1);
    const { rows } = await pool.query(
      `SELECT 1 FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
      ["u1", "k1"],
    );
    expect(rows).toHaveLength(0);
  });

  it("cleanupCompletedIdempotencyKeys keeps recent completed rows and in-flight claims", async () => {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    await claimKey(pool, { key: "processing", userId: "u1", requestHash: "h1" });
    await claimKey(pool, { key: "recent", userId: "u1", requestHash: "h2" });
    await completeKey(pool, {
      userId: "u1",
      key: "recent",
      responseStatus: 200,
      responseBody: { ok: true },
    });

    expect(await cleanupCompletedIdempotencyKeys(pool, sevenDaysMs, now)).toBe(0);

    const { rows } = await pool.query(
      `SELECT key, status FROM idempotency_keys WHERE user_id = 'u1' ORDER BY key`,
    );
    expect(rows).toEqual([
      { key: "processing", status: "processing" },
      { key: "recent", status: "completed" },
    ]);
  });
});
