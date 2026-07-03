import type { ReservationCaps } from "@modelgov/policy-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import {
  loadUsageSnapshot,
  recordActualCost,
  reserveBudget,
} from "../src/modules/usage/repo";
import { cleanupStaleReservationLeases } from "../src/modules/usage/reservationLeases";

const DATABASE_URL = process.env.DATABASE_URL;
const PROJECT = "test";
const NOW = new Date("2026-06-30T12:00:00.000Z");

const caps: ReservationCaps = {
  userDailyUsd: 1,
  userDailyRequests: 100,
  featureMonthlyUsd: null,
  globalMonthlyUsd: null,
};

describe.skipIf(!DATABASE_URL)("reservation lease cleanup (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE budget_counters, budget_reservation_leases");
  });

  it("releases orphaned reserved_usd after the stale TTL", async () => {
    const res = await reserveBudget(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      estimatedCostUsd: 0.04,
      caps,
      now: NOW,
    });
    expect(res.ok).toBe(true);
    expect(res.leaseId).toBeTruthy();

    await pool.query(
      `UPDATE budget_reservation_leases SET leased_at = $1::timestamptz WHERE id = $2::bigint`,
      [new Date(Date.now() - 20 * 60 * 1000).toISOString(), res.leaseId],
    );

    const released = await cleanupStaleReservationLeases(pool, 15 * 60 * 1000);
    expect(released).toBe(1);

    const snap = await loadUsageSnapshot(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      now: NOW,
    });
    expect(snap.userDailyUsdReserved).toBeCloseTo(0, 6);
  });

  it("does not double-free a hold when a settle races the stale-lease sweep (H3)", async () => {
    // Two concurrent reservations share the same user_daily scope counter.
    const r1 = await reserveBudget(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      estimatedCostUsd: 0.4,
      caps,
      now: NOW,
    });
    const r2 = await reserveBudget(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      estimatedCostUsd: 0.4,
      caps,
      now: NOW,
    });
    expect(r1.ok && r2.ok).toBe(true);

    // R1 outlives the TTL; the sweep releases its hold (reserved 0.8 -> 0.4).
    await pool.query(
      `UPDATE budget_reservation_leases SET leased_at = $1::timestamptz WHERE id = $2::bigint`,
      [new Date(Date.now() - 20 * 60 * 1000).toISOString(), r1.leaseId],
    );
    expect(await cleanupStaleReservationLeases(pool, 15 * 60 * 1000)).toBe(1);

    let snap = await loadUsageSnapshot(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      now: NOW,
    });
    expect(snap.userDailyUsdReserved).toBeCloseTo(0.4, 6); // only R2's hold remains

    // The slow R1 request finally settles against its now-swept lease. Because
    // the lease is the single-use idempotency token, a settle whose lease is
    // already gone is a NO-OP: it must NOT decrement reserved again (that would
    // steal R2's still-outstanding 0.4 hold and let R2 overshoot) AND it must NOT
    // book used again. The lease being gone is ambiguous — it could equally be a
    // retry of an already-committed settle — so booking regardless would
    // double-charge the customer on every settle retry. We choose the safe
    // direction: this pathological "settle after my own lease was swept" case
    // (only reachable when a request outlives RESERVATION_STALE_MS, which the
    // boot check warns about) undercounts rather than double-charges.
    await recordActualCost(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      actualCostUsd: 0.4,
      estimatedCostUsd: 0.4,
      caps,
      now: NOW,
      leaseId: r1.leaseId,
    });

    snap = await loadUsageSnapshot(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      now: NOW,
    });
    expect(snap.userDailyUsdReserved).toBeCloseTo(0.4, 6); // R2's hold intact
    expect(snap.userDailyUsdUsed).toBeCloseTo(0, 6); // swept lease → settle is a no-op (no double-charge)
  });
});
