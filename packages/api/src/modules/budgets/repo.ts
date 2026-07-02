import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../db/pool";
import { dayWindowStart, monthWindowStart } from "../../services/windows";

// Hierarchical budgets. Standalone from the flat budget_counters path (which
// remains the default); this powers org → dept → team → user → feature nesting.
// The atomic multi-level reservation mirrors the proven flat upsert: a single
// check-and-increment statement per node (rowCount 0 = cap breach), all inside
// one transaction, with nodes locked in ascending id order so concurrent
// requests that share ancestors can never deadlock.

const LOCK_TIMEOUT_MS = 3000;
const MAX_DEPTH = 32;

export type NodeKind = "org" | "dept" | "team" | "user" | "feature";
export type BudgetWindow = "daily" | "monthly";

export interface BudgetNode {
  id: string;
  tenantId: string;
  parentId?: string;
  kind: NodeKind;
  name: string;
  window: BudgetWindow;
  capUsd: number | null;
  requestCap: number | null;
  /** >1 splits this node's counter into N shards, each with cap/N. */
  shardCount: number;
}

interface NodeDbRow {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  kind: NodeKind;
  name: string;
  budget_window: BudgetWindow;
  cap_usd: string | null;
  request_cap: number | null;
  shard_count: number;
}

const NODE_FIELDS = "id, tenant_id, parent_id, kind, name, budget_window, cap_usd, request_cap, shard_count";

function rowToNode(r: NodeDbRow): BudgetNode {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    parentId: r.parent_id ?? undefined,
    kind: r.kind,
    name: r.name,
    window: r.budget_window,
    capUsd: r.cap_usd != null ? Number(r.cap_usd) : null,
    requestCap: r.request_cap,
    shardCount: r.shard_count ?? 1,
  };
}

/** FNV-1a → shard index for a node. shardKey empty / shardCount<=1 → shard 0. */
function shardFor(shardCount: number, shardKey: string): number {
  if (shardCount <= 1 || !shardKey) return 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < shardKey.length; i++) {
    h ^= shardKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % shardCount;
}

export interface CreateNodeInput {
  tenantId: string;
  parentId?: string;
  kind: NodeKind;
  name: string;
  window?: BudgetWindow;
  capUsd?: number | null;
  requestCap?: number | null;
  shardCount?: number;
}

export async function createNode(pool: Pool, input: CreateNodeInput): Promise<BudgetNode> {
  const { rows } = await pool.query<NodeDbRow>(
    `INSERT INTO budget_nodes (tenant_id, parent_id, kind, name, budget_window, cap_usd, request_cap, shard_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${NODE_FIELDS}`,
    [
      input.tenantId,
      input.parentId ?? null,
      input.kind,
      input.name,
      input.window ?? "monthly",
      input.capUsd ?? null,
      input.requestCap ?? null,
      Math.max(1, input.shardCount ?? 1),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("budget node insert returned no row");
  return rowToNode(row);
}

/**
 * Fetch a node by id, optionally constrained to a tenant. Pass `tenantId` on any
 * caller-driven lookup (the chat path) so one tenant can never read or bill
 * another tenant's node; omit it only for tenant-agnostic tooling/tests. Node ids
 * are sequential bigints, so the tenant filter also stops org-structure
 * enumeration via node lookups.
 */
export async function getNode(
  pool: Pool,
  id: string,
  tenantId?: string,
): Promise<BudgetNode | null> {
  const { rows } =
    tenantId === undefined
      ? await pool.query<NodeDbRow>(`SELECT ${NODE_FIELDS} FROM budget_nodes WHERE id = $1`, [id])
      : await pool.query<NodeDbRow>(
          `SELECT ${NODE_FIELDS} FROM budget_nodes WHERE id = $1 AND tenant_id = $2`,
          [id, tenantId],
        );
  return rows[0] ? rowToNode(rows[0]) : null;
}

export async function listNodes(pool: Pool, tenantId: string): Promise<BudgetNode[]> {
  const { rows } = await pool.query<NodeDbRow>(
    `SELECT ${NODE_FIELDS} FROM budget_nodes WHERE tenant_id = $1 ORDER BY id`,
    [tenantId],
  );
  return rows.map(rowToNode);
}

/**
 * Resolve a leaf node's full path root→leaf by walking parent_id. Returns [] if
 * the leaf is unknown; throws on a cycle or a path deeper than MAX_DEPTH (a
 * corrupt tree must fail loudly, not loop).
 */
export async function resolvePath(
  pool: Pool,
  leafId: string,
  tenantId?: string,
): Promise<BudgetNode[]> {
  const path: BudgetNode[] = [];
  const seen = new Set<string>();
  let current: string | undefined = leafId;
  while (current) {
    if (seen.has(current)) throw new Error(`cycle in budget_nodes at id ${current}`);
    if (path.length >= MAX_DEPTH) throw new Error(`budget_nodes path exceeds max depth ${MAX_DEPTH}`);
    seen.add(current);
    // The leaf is tenant-filtered; ancestors inherit the same tenant (a tree is
    // single-tenant), so filtering every hop also rejects a corrupt cross-tenant
    // parent link rather than silently walking into another tenant's subtree.
    const node = await getNode(pool, current, tenantId);
    if (!node) return path.length === 0 ? [] : path.reverse();
    path.push(node);
    current = node.parentId;
  }
  return path.reverse();
}

function windowStartFor(node: BudgetNode, now: Date): string {
  return node.window === "daily" ? dayWindowStart(now) : monthWindowStart(now);
}

export interface PathReservationEntry {
  nodeId: string;
  windowStart: string;
  shard: number;
}

export interface PathReservation {
  entries: PathReservationEntry[];
  amountUsd: number;
  requestDelta: number;
  /** Lease row id; deleted on settle/release, reconciled by the sweep if stranded. */
  leaseId?: string;
}

export interface PathNodeUsage {
  nodeId: string;
  usedUsd: number;
  reservedUsd: number;
  requestsUsed: number;
}

/**
 * Load per-node used/reserved/requests for a path at the given time (each node
 * in its own window bucket). Nodes with no counter row yet report zeros. Feeds
 * the pure `evaluateBudgetPath` pre-check.
 */
export async function loadPathSnapshot(
  pool: Pool,
  nodes: BudgetNode[],
  now: Date,
): Promise<Map<string, PathNodeUsage>> {
  const out = new Map<string, PathNodeUsage>();
  for (const n of nodes) out.set(n.id, { nodeId: n.id, usedUsd: 0, reservedUsd: 0, requestsUsed: 0 });
  if (nodes.length === 0) return out;
  const ids = nodes.map((n) => n.id);
  // Sum across shards so a sharded node reports its total spend for the window.
  // window_start is cast to text ('YYYY-MM-DD') in SQL: node-pg parses a `date`
  // column at the server's LOCAL midnight, so `.toISOString()` on a TZ ahead of
  // UTC shifts the day and silently drops the current window's rows. The lease
  // repo casts for this exact reason; match it here.
  const { rows } = await pool.query<{
    node_id: string;
    window_start: string;
    used_usd: string;
    reserved_usd: string;
    requests_used: string;
  }>(
    `SELECT node_id, window_start::text AS window_start,
            SUM(used_usd) AS used_usd, SUM(reserved_usd) AS reserved_usd, SUM(requests_used) AS requests_used
     FROM budget_node_counters WHERE node_id = ANY($1::bigint[])
     GROUP BY node_id, window_start`,
    [ids],
  );
  const wantWindow = new Map(nodes.map((n) => [n.id, windowStartFor(n, now)]));
  for (const r of rows) {
    // A node counter row's window_start is a date; match the node's current bucket.
    if (r.window_start !== wantWindow.get(r.node_id)) continue;
    out.set(r.node_id, {
      nodeId: r.node_id,
      usedUsd: Number(r.used_usd),
      reservedUsd: Number(r.reserved_usd),
      requestsUsed: Number(r.requests_used),
    });
  }
  return out;
}

export interface ReservePathResult {
  ok: boolean;
  failedNodeId?: string;
  reservation?: PathReservation;
}

class NodeRejected extends Error {
  constructor(readonly nodeId: string) {
    super(`reservation rejected at node ${nodeId}`);
    this.name = "NodeRejected";
  }
}

// Same check-and-increment shape as the flat RESERVE_SQL: the INSERT…SELECT…
// WHERE guards a fresh window row; the ON CONFLICT DO UPDATE…WHERE guards an
// existing row. rowCount 0 means the cap would be breached.
const NODE_RESERVE_SQL = `
  INSERT INTO budget_node_counters (node_id, window_start, shard, used_usd, reserved_usd, requests_used)
  SELECT $1, $2, $7, 0, $3, $4
  WHERE ($5::numeric IS NULL OR $3::numeric <= $5::numeric)
    AND ($6::int IS NULL OR $4::int <= $6::int)
  ON CONFLICT (node_id, window_start, shard) DO UPDATE
    SET reserved_usd  = budget_node_counters.reserved_usd + EXCLUDED.reserved_usd,
        requests_used = budget_node_counters.requests_used + EXCLUDED.requests_used
    WHERE ($5::numeric IS NULL
           OR budget_node_counters.used_usd + budget_node_counters.reserved_usd + EXCLUDED.reserved_usd <= $5::numeric)
      AND ($6::int IS NULL
           OR budget_node_counters.requests_used + EXCLUDED.requests_used <= $6::int)
  RETURNING reserved_usd
`;

/**
 * Atomically reserve `estimatedCostUsd` against every node on the path. All caps
 * on the path must pass or the whole reservation rolls back. Uncapped nodes
 * still accumulate (for roll-up reporting). Nodes are processed in ascending id
 * order for deadlock safety.
 */
export async function reservePath(
  pool: Pool,
  params: {
    nodes: BudgetNode[];
    estimatedCostUsd: number;
    now: Date;
    requestDelta?: number;
    /** Distributes load across a sharded node's shards (e.g. userId). */
    shardKey?: string;
  },
): Promise<ReservePathResult> {
  const requestDelta = params.requestDelta ?? 1;
  const shardKey = params.shardKey ?? "";
  const ordered = [...params.nodes].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const entries: PathReservationEntry[] = ordered.map((n) => ({
    nodeId: n.id,
    windowStart: windowStartFor(n, params.now),
    shard: shardFor(n.shardCount, shardKey),
  }));
  try {
    const leaseId = await withTransaction(
      pool,
      async (client) => {
        for (const node of ordered) {
          const windowStart = windowStartFor(node, params.now);
          const shard = shardFor(node.shardCount, shardKey);
          // Each shard gets an equal fraction of the node's cap.
          const effectiveCap = node.capUsd != null && node.shardCount > 1
            ? node.capUsd / node.shardCount
            : node.capUsd;
          const effectiveReqCap = node.requestCap != null && node.shardCount > 1
            ? Math.floor(node.requestCap / node.shardCount)
            : node.requestCap;
          const res = await client.query(NODE_RESERVE_SQL, [
            node.id,
            windowStart,
            params.estimatedCostUsd,
            requestDelta,
            effectiveCap,
            effectiveReqCap,
            shard,
          ]);
          if (res.rowCount === 0) throw new NodeRejected(node.id);
        }
        const lease = await client.query<{ id: string }>(
          `INSERT INTO budget_node_leases (entries, amount_usd, request_delta)
           VALUES ($1::jsonb, $2, $3) RETURNING id`,
          [JSON.stringify(entries), params.estimatedCostUsd, requestDelta],
        );
        return lease.rows[0]?.id;
      },
      { lockTimeoutMs: LOCK_TIMEOUT_MS },
    );
    return {
      ok: true,
      reservation: { entries, amountUsd: params.estimatedCostUsd, requestDelta, leaseId },
    };
  } catch (err) {
    if (err instanceof NodeRejected) return { ok: false, failedNodeId: err.nodeId };
    throw err;
  }
}

function orderEntries(entries: PathReservationEntry[]): PathReservationEntry[] {
  return [...entries].sort((a, b) => (BigInt(a.nodeId) < BigInt(b.nodeId) ? -1 : 1));
}

async function settleEntries(
  client: PoolClient,
  entries: PathReservationEntry[],
  amountUsd: number,
  actualCostUsd: number,
): Promise<void> {
  for (const e of orderEntries(entries)) {
    await client.query(
      `UPDATE budget_node_counters
         SET used_usd = used_usd + $4, reserved_usd = GREATEST(reserved_usd - $5, 0)
       WHERE node_id = $1 AND window_start = $2 AND shard = $3`,
      [e.nodeId, e.windowStart, e.shard, actualCostUsd, amountUsd],
    );
  }
}

async function releaseEntries(
  client: PoolClient,
  entries: PathReservationEntry[],
  amountUsd: number,
  requestDelta: number,
): Promise<void> {
  for (const e of orderEntries(entries)) {
    await client.query(
      `UPDATE budget_node_counters
         SET reserved_usd = GREATEST(reserved_usd - $4, 0),
             requests_used = GREATEST(requests_used - $5, 0)
       WHERE node_id = $1 AND window_start = $2 AND shard = $3`,
      [e.nodeId, e.windowStart, e.shard, amountUsd, requestDelta],
    );
  }
}

/** Settle a reservation: book actual cost as used, release the held estimate, drop the lease. */
export async function settlePath(
  pool: Pool,
  reservation: PathReservation,
  actualCostUsd: number,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    // Delete the lease first and only release the held estimate if this
    // transaction removed it — mirrors the flat path's recordActualCost. If the
    // stale-lease sweep already released this reservation, releasing the reserved
    // amount again double-frees the node counters and lets other in-flight
    // requests overshoot the node cap. used_usd is booked regardless.
    const holdOutstanding = await deleteNodeLease(client, reservation.leaseId);
    await settleEntries(
      client,
      reservation.entries,
      holdOutstanding ? reservation.amountUsd : 0,
      actualCostUsd,
    );
  }, { lockTimeoutMs: LOCK_TIMEOUT_MS });
}

/** Release a reservation (provider failure / client disconnect): free the hold, drop the lease. */
export async function releasePath(pool: Pool, reservation: PathReservation): Promise<void> {
  await withTransaction(pool, async (client) => {
    // Only free the hold if this transaction deletes the lease; if the sweep (or
    // a settle) already dropped it, releasing again double-frees the counters.
    const holdOutstanding = await deleteNodeLease(client, reservation.leaseId);
    if (!holdOutstanding) return;
    await releaseEntries(client, reservation.entries, reservation.amountUsd, reservation.requestDelta);
  }, { lockTimeoutMs: LOCK_TIMEOUT_MS });
}

/**
 * Delete a node reservation lease, returning whether this call actually removed
 * it (i.e. the hold is ours to free). Returns true when there is no lease id so
 * lease-less callers keep their prior always-release behaviour.
 */
async function deleteNodeLease(client: PoolClient, leaseId?: string): Promise<boolean> {
  if (!leaseId) return true;
  const del = await client.query("DELETE FROM budget_node_leases WHERE id = $1", [leaseId]);
  return (del.rowCount ?? 0) > 0;
}

/**
 * Book already-spent cost (the input-safety classifier) against every node on
 * the path without a reservation, cap check, or lease. Mirrors the flat
 * `recordIncurredCost`: a blocked request must still account for real provider
 * spend, but the booking never gates the rejection.
 */
export async function recordIncurredPathCost(
  pool: Pool,
  nodes: BudgetNode[],
  params: { costUsd: number; now: Date; shardKey?: string },
): Promise<void> {
  if (params.costUsd <= 0 || nodes.length === 0) return;
  const shardKey = params.shardKey ?? "";
  const ordered = [...nodes].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  await withTransaction(
    pool,
    async (client) => {
      for (const node of ordered) {
        await client.query(
          `INSERT INTO budget_node_counters (node_id, window_start, shard, used_usd, reserved_usd, requests_used)
           VALUES ($1, $2, $3, $4, 0, 0)
           ON CONFLICT (node_id, window_start, shard) DO UPDATE
             SET used_usd = budget_node_counters.used_usd + EXCLUDED.used_usd`,
          [node.id, windowStartFor(node, params.now), shardFor(node.shardCount, shardKey), params.costUsd],
        );
      }
    },
    { lockTimeoutMs: LOCK_TIMEOUT_MS },
  );
}

/**
 * Release path reservations whose lease is older than `staleMs` (worker crashed
 * between reserve and settle). Mirrors the flat reservation-lease sweep. Runs in
 * one transaction using SKIP LOCKED so replicas don't contend.
 */
export async function cleanupStaleNodeLeases(
  pool: Pool,
  staleMs: number,
  now = Date.now(),
): Promise<number> {
  const cutoff = new Date(now - staleMs).toISOString();
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      id: string;
      entries: PathReservationEntry[];
      amount_usd: string;
      request_delta: number;
    }>(
      `SELECT id::text, entries, amount_usd, request_delta
       FROM budget_node_leases WHERE leased_at < $1::timestamptz
       ORDER BY id FOR UPDATE SKIP LOCKED`,
      [cutoff],
    );
    for (const row of rows) {
      await releaseEntries(client, row.entries, Number(row.amount_usd), row.request_delta);
      await client.query("DELETE FROM budget_node_leases WHERE id = $1", [row.id]);
    }
    return rows.length;
  }, { lockTimeoutMs: LOCK_TIMEOUT_MS });
}
