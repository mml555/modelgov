import type { ReservationCaps } from "@ai-guard/policy-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import {
  loadUsageSnapshot,
  recordActualCost,
  releaseBudget,
  reserveBudget,
  topUpBudget,
} from "../src/modules/usage/repo";

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date("2026-06-30T12:00:00Z");
const PROJECT = "test-project";

const caps = (over: Partial<ReservationCaps> = {}): ReservationCaps => ({
  userDailyUsd: 1,
  userDailyRequests: 1000,
  featureMonthlyUsd: null,
  globalMonthlyUsd: null,
  ...over,
});

describe.skipIf(!DATABASE_URL)("usage service (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE budget_counters, request_logs, budget_reservation_leases");
  });

  it("tenants with the same project/user/feature do NOT share counters (incl. global_monthly)", async () => {
    // Global cap of $1. Tenant A exhausts it. Tenant B must be unaffected — its
    // own global_monthly counter is a separate row keyed by tenant_id.
    const gcaps = caps({ globalMonthlyUsd: 1, userDailyUsd: 100 });
    const a1 = await reserveBudget(pool, {
      projectId: PROJECT, userId: "shared", feature: "support_chat",
      estimatedCostUsd: 0.9, caps: gcaps, now: NOW, tenantId: "tenant-a",
    });
    expect(a1.ok).toBe(true);
    // Tenant A's second reserve would breach A's global cap ($0.9 + $0.9 > $1).
    const a2 = await reserveBudget(pool, {
      projectId: PROJECT, userId: "shared", feature: "support_chat",
      estimatedCostUsd: 0.9, caps: gcaps, now: NOW, tenantId: "tenant-a",
    });
    expect(a2.ok).toBe(false);
    expect(a2.failedScope).toBe("global_monthly");
    // Tenant B, same project/user/feature, has its OWN empty global counter.
    const b1 = await reserveBudget(pool, {
      projectId: PROJECT, userId: "shared", feature: "support_chat",
      estimatedCostUsd: 0.9, caps: gcaps, now: NOW, tenantId: "tenant-b",
    });
    expect(b1.ok).toBe(true);
    // B's snapshot sees only B's spend, not A's.
    const snapB = await loadUsageSnapshot(pool, {
      projectId: PROJECT, userId: "shared", feature: "support_chat", now: NOW, tenantId: "tenant-b",
    });
    expect(snapB.globalMonthlyUsdReserved).toBeCloseTo(0.9, 6);
  });

  it("reserve then snapshot reflects reserved spend", async () => {
    const res = await reserveBudget(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      estimatedCostUsd: 0.03,
      caps: caps(),
      now: NOW,
    });
    expect(res.ok).toBe(true);

    const snap = await loadUsageSnapshot(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      now: NOW,
    });
    expect(snap.userDailyUsdReserved).toBeCloseTo(0.03, 6);
    expect(snap.userDailyRequestsUsed).toBe(1);
    expect(snap.globalMonthlyUsdReserved).toBeCloseTo(0.03, 6);
  });

  it("topUpBudget increases an in-flight reservation", async () => {
    const res = await reserveBudget(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      estimatedCostUsd: 0.03,
      caps: caps(),
      now: NOW,
    });
    expect(res.ok).toBe(true);
    const top = await topUpBudget(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      additionalCostUsd: 0.02,
      caps: caps(),
      now: NOW,
      leaseId: res.leaseId,
    });
    expect(top.ok).toBe(true);
    const snap = await loadUsageSnapshot(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      now: NOW,
    });
    expect(snap.userDailyUsdReserved).toBeCloseTo(0.05, 6);
  });

  it("recordActualCost moves reserved -> used", async () => {
    await reserveBudget(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      estimatedCostUsd: 0.03,
      caps: caps(),
      now: NOW,
    });
    await recordActualCost(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      actualCostUsd: 0.018,
      estimatedCostUsd: 0.03,
      caps: caps(),
      now: NOW,
    });
    const snap = await loadUsageSnapshot(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      now: NOW,
    });
    expect(snap.userDailyUsdUsed).toBeCloseTo(0.018, 6);
    expect(snap.userDailyUsdReserved).toBeCloseTo(0, 6);
  });

  it("releaseBudget rolls back the reservation and request count", async () => {
    await reserveBudget(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      estimatedCostUsd: 0.03,
      caps: caps(),
      now: NOW,
    });
    await releaseBudget(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      estimatedCostUsd: 0.03,
      caps: caps(),
      now: NOW,
    });
    const snap = await loadUsageSnapshot(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      now: NOW,
    });
    expect(snap.userDailyUsdReserved).toBeCloseTo(0, 6);
    expect(snap.userDailyRequestsUsed).toBe(0);
  });

  it("rejects a reservation that would exceed the cap", async () => {
    const tight = caps({ userDailyUsd: 0.05 });
    const a = await reserveBudget(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      estimatedCostUsd: 0.03,
      caps: tight,
      now: NOW,
    });
    const b = await reserveBudget(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      estimatedCostUsd: 0.03,
      caps: tight,
      now: NOW,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.failedScope).toBe("user_daily");
  });

  it("admits exactly floor(cap/est) of N concurrent reservations", async () => {
    const tight = caps({ userDailyUsd: 0.1 });
    const N = 12;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        reserveBudget(pool, {
          projectId: PROJECT,
          userId: "burst",
          feature: "support_chat",
          estimatedCostUsd: 0.03,
          caps: tight,
          now: NOW,
        }),
      ),
    );
    const admitted = results.filter((r) => r.ok).length;
    expect(admitted).toBe(3);

    const snap = await loadUsageSnapshot(pool, {
      projectId: PROJECT,
      userId: "burst",
      feature: "support_chat",
      now: NOW,
    });
    expect(snap.userDailyUsdReserved).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(snap.userDailyUsdReserved).toBeCloseTo(0.09, 6);
    expect(snap.userDailyRequestsUsed).toBe(3);
  });

  it("isolates user_daily budgets per project_id", async () => {
    const tight = caps({ userDailyUsd: 0.05 });
    const a = await reserveBudget(pool, {
      projectId: "tenant-a",
      userId: "shared-user",
      feature: "support_chat",
      estimatedCostUsd: 0.04,
      caps: tight,
      now: NOW,
    });
    const b = await reserveBudget(pool, {
      projectId: "tenant-b",
      userId: "shared-user",
      feature: "support_chat",
      estimatedCostUsd: 0.04,
      caps: tight,
      now: NOW,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const snapA = await loadUsageSnapshot(pool, {
      projectId: "tenant-a",
      userId: "shared-user",
      feature: "support_chat",
      now: NOW,
    });
    const snapB = await loadUsageSnapshot(pool, {
      projectId: "tenant-b",
      userId: "shared-user",
      feature: "support_chat",
      now: NOW,
    });
    expect(snapA.userDailyUsdReserved).toBeCloseTo(0.04, 6);
    expect(snapB.userDailyUsdReserved).toBeCloseTo(0.04, 6);
  });
});
