# Multi-tenancy & hierarchical budgets — design & status

The largest remaining item: move from single-config / flat budgets to true
multi-tenant isolation with nested budgets (org → dept → team → user → feature),
without weakening the concurrency guarantees the current budget engine already
proves.

> **Status:** this is a **design** for the full build. The foundations below
> exist today; the hierarchy, counter-sharding, and tenant isolation are the
> net-new work.

## What exists today (foundations)

- **Project scoping.** `budget_counters` is partitioned by `project_id`
  (migration `0005`); `user_daily` and `feature_monthly` counters are already
  per-project. API keys carry a `projectId` and requests are scoped to it
  (chat/usage/requests reject cross-project access).
- **Atomic reservations.** `reserveBudget()` increments `reserved_usd` under row
  locks and re-checks caps in one transaction; `usage.integration.test.ts`
  proves the exact admission count under concurrency.
- **Per-key scoping.** `projectId` / `environment` / `allowedUserTypes` /
  `allowedUserIds` on each key (now DB-backed, rotatable).

## Gaps

1. **One global counter row.** The global monthly cap is a single
   `budget_counters` row — correct under concurrency but a throughput ceiling at
   very high RPS (all requests contend on one row).
2. **Flat budgets.** Caps exist at `user_type` (daily) and `feature` (monthly)
   and one global — there is no org → dept → team nesting.
3. **Soft tenant isolation.** Isolation is by `project_id` on a shared schema;
   there is no hard tenant boundary (separate credentials/roles per tenant).

## Design

### Budget hierarchy

A `budget_nodes` tree replaces the flat dimensions:

```
budget_nodes(
  id, tenant_id, parent_id, kind,           -- org | dept | team | user | feature
  name,
  window,                                    -- daily | monthly
  cap_usd, request_cap,                      -- nullable = no cap at this level
  primary key (id)
)
```

A request maps to a **leaf path** (e.g. `org:acme → dept:support → team:tier1 →
user:u123 → feature:support_chat`). Every node on the path with a cap is a
budget dimension the request must satisfy.

`budget_counters` becomes `(node_id, window_start)` instead of
`(scope, key, window_start)`.

### Atomic multi-level reservation

Reservation must be all-or-nothing across every ancestor cap:

```
BEGIN
  -- Lock the path's counter rows in a FIXED order (ascending node_id) to make
  -- deadlock impossible when two requests share ancestors.
  SELECT ... FROM budget_counters
   WHERE node_id = ANY($path) AND window_start = $win
   ORDER BY node_id FOR UPDATE;
  -- Re-check every capped node against used+reserved+estimate.
  -- If ALL pass: increment reserved_usd on every node on the path.
  -- Else: rollback → block with the failing node in the reason.
COMMIT
```

This generalizes today's reserve-then-recheck to N levels while preserving the
single-transaction guarantee. Settlement (`recordActualCost`) and release walk
the same path.

### Removing the global-counter ceiling

Shard the top (org/global) counter into `N` sub-rows
(`node_id, shard, window_start`); a request reserves against
`shard = hash(userId) % N`. The cap check sums shards. This trades a single hot
row for `N` cooler rows; `N` is a deploy-time constant. The per-user/team rows
are already naturally sharded by key, so only the top of the tree needs it.

### Tenant isolation

- Each key/operator is bound to a `tenant_id`; every query is filtered by it
  (row-level scoping today, optionally Postgres RLS policies for defense in
  depth).
- Policy versions (`config_versions`) gain a `tenant_id` so each tenant has its
  own policy lineage.
- Per-tenant config is the natural extension of the [dynamic policy
  store](./dynamic-policy.md).

### Engine changes

The pure engine's `UsageSnapshot` / `ReservationCaps` become **arrays keyed by
node**, and `evaluateAiRequest` walks the path instead of the three fixed
dimensions. The decision/reason-code contract is unchanged (a block names the
failing node). This keeps the engine pure and unit-testable, and lets the
concurrency proof extend to the hierarchy.

## Rollout

1. Ship `budget_nodes` + counter migration behind a flag; keep the flat path as
   the default.
2. Port `reserveBudget`/`recordActualCost`/`releaseBudget` to the path walk;
   extend the concurrency test to a 3-level tree.
3. Shard the top counter; publish the RPS benchmark (see
   [benchmarks](../deployment/benchmarks.md)).
4. Add tenant binding to keys + policy versions; enable RLS.

Each step is independently shippable and testable.
