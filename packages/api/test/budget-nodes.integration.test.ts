import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import {
  cleanupStaleNodeLeases,
  createNode,
  listNodes,
  releasePath,
  reservePath,
  resolvePath,
  settlePath,
  type BudgetNode,
} from "../src/modules/budgets/repo";

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date("2026-07-01T12:00:00Z");

async function counter(pool: Pool, nodeId: string): Promise<{ used: number; reserved: number; requests: number }> {
  const { rows } = await pool.query(
    "SELECT used_usd, reserved_usd, requests_used FROM budget_node_counters WHERE node_id = $1",
    [nodeId],
  );
  const r = rows[0] ?? { used_usd: 0, reserved_usd: 0, requests_used: 0 };
  return { used: Number(r.used_usd), reserved: Number(r.reserved_usd), requests: Number(r.requests_used) };
}

describe.skipIf(!DATABASE_URL)("hierarchical budgets (integration)", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE budget_node_counters, budget_node_leases, budget_nodes RESTART IDENTITY CASCADE");
  });

  async function tree(orgCap: number | null): Promise<{ org: BudgetNode; team: BudgetNode; user: BudgetNode }> {
    const org = await createNode(pool, { tenantId: "acme", kind: "org", name: "acme", window: "monthly", capUsd: orgCap });
    const team = await createNode(pool, { tenantId: "acme", parentId: org.id, kind: "team", name: "tier1", window: "monthly" });
    const user = await createNode(pool, { tenantId: "acme", parentId: team.id, kind: "user", name: "u123", window: "monthly" });
    return { org, team, user };
  }

  it("resolves a leaf path root→leaf", async () => {
    const { org, team, user } = await tree(null);
    const path = await resolvePath(pool, user.id);
    expect(path.map((n) => n.id)).toEqual([org.id, team.id, user.id]);
    expect(await resolvePath(pool, "999999")).toEqual([]);
    expect((await listNodes(pool, "acme")).length).toBe(3);
  });

  it("enforces an ancestor cap atomically under concurrency", async () => {
    const { org, user } = await tree(1.0); // org monthly cap $1
    const path = await resolvePath(pool, user.id);

    // 10 concurrent $0.30 reservations against the shared org cap. Exactly
    // floor(1.0 / 0.3) = 3 may be admitted; the rest reject on the org node.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reservePath(pool, { nodes: path, estimatedCostUsd: 0.3, now: NOW })),
    );
    const admitted = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok);
    expect(admitted).toHaveLength(3);
    expect(rejected).toHaveLength(7);
    expect(rejected.every((r) => r.failedNodeId === org.id)).toBe(true);

    // The org counter reflects exactly the admitted reservations.
    const c = await counter(pool, org.id);
    expect(c.reserved).toBeCloseTo(0.9, 6);
    expect(c.requests).toBe(3);
  });

  it("enforces a request_cap on a node", async () => {
    const org = await createNode(pool, { tenantId: "t", kind: "org", name: "o", requestCap: 2 });
    const path = [org];
    const r1 = await reservePath(pool, { nodes: path, estimatedCostUsd: 0.01, now: NOW });
    const r2 = await reservePath(pool, { nodes: path, estimatedCostUsd: 0.01, now: NOW });
    const r3 = await reservePath(pool, { nodes: path, estimatedCostUsd: 0.01, now: NOW });
    expect([r1.ok, r2.ok, r3.ok]).toEqual([true, true, false]);
    expect(r3.failedNodeId).toBe(org.id);
  });

  it("settles reserved → used across every node on the path (roll-up)", async () => {
    const { org, team, user } = await tree(10);
    const path = await resolvePath(pool, user.id);
    const r = await reservePath(pool, { nodes: path, estimatedCostUsd: 0.5, now: NOW });
    expect(r.ok).toBe(true);
    await settlePath(pool, r.reservation!, 0.42);

    for (const n of [org, team, user]) {
      const c = await counter(pool, n.id);
      expect(c.used, `node ${n.kind}`).toBeCloseTo(0.42, 6);
      expect(c.reserved, `node ${n.kind}`).toBeCloseTo(0, 6);
    }
  });

  it("releases a reservation (frees hold + request count)", async () => {
    const { org, user } = await tree(10);
    const path = await resolvePath(pool, user.id);
    const r = await reservePath(pool, { nodes: path, estimatedCostUsd: 0.5, now: NOW });
    expect((await counter(pool, org.id)).reserved).toBeCloseTo(0.5, 6);
    await releasePath(pool, r.reservation!);
    const c = await counter(pool, org.id);
    expect(c.reserved).toBeCloseTo(0, 6);
    expect(c.requests).toBe(0);
  });

  it("does not double-free a node hold when a settle races the stale-lease sweep (H3)", async () => {
    const { org, user } = await tree(10);
    const path = await resolvePath(pool, user.id);
    const r1 = await reservePath(pool, { nodes: path, estimatedCostUsd: 0.4, now: NOW });
    const r2 = await reservePath(pool, { nodes: path, estimatedCostUsd: 0.4, now: NOW });
    expect(r1.ok && r2.ok).toBe(true);
    expect((await counter(pool, org.id)).reserved).toBeCloseTo(0.8, 6);

    // R1 outlives the TTL; the sweep frees its hold (org reserved 0.8 -> 0.4).
    await pool.query(
      `UPDATE budget_node_leases SET leased_at = $1::timestamptz WHERE id = $2::bigint`,
      [new Date(Date.now() - 20 * 60 * 1000).toISOString(), r1.reservation!.leaseId],
    );
    expect(await cleanupStaleNodeLeases(pool, 15 * 60 * 1000)).toBe(1);
    expect((await counter(pool, org.id)).reserved).toBeCloseTo(0.4, 6);

    // Slow R1 settles against its swept lease: book used, but do not re-free the
    // hold (that would steal R2's still-outstanding 0.4 and let R2 overshoot).
    await settlePath(pool, r1.reservation!, 0.4);
    const c = await counter(pool, org.id);
    expect(c.reserved).toBeCloseTo(0.4, 6); // R2's hold intact
    expect(c.used).toBeCloseTo(0.4, 6); // R1's spend still booked
  });

  it("shards a hot node: per-shard sub-cap enforced, total bounded, load spread", async () => {
    // shardCount 3, cap $0.90 → each shard gets $0.30.
    const org = await createNode(pool, { tenantId: "t", kind: "org", name: "o", capUsd: 0.9, shardCount: 3 });
    const path = [org];

    // (a) Same shardKey is confined to one shard → its $0.30 sub-cap.
    const first = await reservePath(pool, { nodes: path, estimatedCostUsd: 0.3, now: NOW, shardKey: "same" });
    const second = await reservePath(pool, { nodes: path, estimatedCostUsd: 0.3, now: NOW, shardKey: "same" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false); // 0.30 + 0.30 > 0.30 on that shard
    expect(second.failedNodeId).toBe(org.id);
  });

  it("spreads across shards and never exceeds the total cap", async () => {
    const org = await createNode(pool, { tenantId: "t", kind: "org", name: "o", capUsd: 1.0, shardCount: 4 });
    // 20 distinct keys × $0.10; per-shard cap $0.25 admits 2 each (max 8 total).
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reservePath(pool, { nodes: [org], estimatedCostUsd: 0.1, now: NOW, shardKey: `user-${i}` }),
      ),
    );
    const { rows } = await pool.query(
      "SELECT shard, reserved_usd FROM budget_node_counters WHERE node_id = $1",
      [org.id],
    );
    const total = rows.reduce((s, r) => s + Number(r.reserved_usd), 0);
    expect(total).toBeLessThanOrEqual(1.0 + 1e-9); // never exceeds the org cap
    expect(rows.length).toBeGreaterThan(1); // load spread across multiple shard rows
    expect(total).toBeGreaterThan(0.25); // capacity beyond a single shard row
  });

  it("uses per-node windows (daily vs monthly buckets)", async () => {
    const org = await createNode(pool, { tenantId: "t", kind: "org", name: "o", window: "monthly", capUsd: 10 });
    const user = await createNode(pool, { tenantId: "t", parentId: org.id, kind: "user", name: "u", window: "daily", capUsd: 5 });
    const path = await resolvePath(pool, user.id);
    await reservePath(pool, { nodes: path, estimatedCostUsd: 1, now: NOW });

    const orgWin = await pool.query("SELECT window_start FROM budget_node_counters WHERE node_id = $1", [org.id]);
    const userWin = await pool.query("SELECT window_start FROM budget_node_counters WHERE node_id = $1", [user.id]);
    expect(orgWin.rows[0].window_start.toISOString().slice(0, 10)).toBe("2026-07-01"); // month bucket = 1st
    expect(userWin.rows[0].window_start.toISOString().slice(0, 10)).toBe("2026-07-01"); // day bucket
  });
});
