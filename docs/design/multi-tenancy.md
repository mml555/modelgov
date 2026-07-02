# Multi-tenancy & hierarchical budgets — design & status

The largest remaining item: move from single-config / flat budgets to true
multi-tenant isolation with nested budgets (org → dept → team → user → feature),
without weakening the concurrency guarantees the current budget engine already
proves.

> **Status:** hierarchical budgets are now **built end-to-end behind a flag**
> (`HIERARCHICAL_BUDGETS=true`): the `budget_nodes` tree + counters + leases,
> atomic multi-level reserve/settle/release (concurrency-proven), the pure
> engine path-walk, `/v1/chat` wiring, counter sharding, and tenant-bound keys +
> per-tenant policy versions. The **flat path remains the default**.
> **Per-request per-tenant policy resolution** (`MULTI_TENANT_POLICY=true`) and
> **opt-in Postgres RLS** (`DB_RLS_ENABLED=true`) are implemented and covered by
> integration tests. Usage/requests reads and GDPR erasure are tenant-scoped when
> the API key carries a `tenantId`.

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

## Remaining gaps (operational / scale)

1. **Global counter row (flat path).** The global monthly cap is a single
   `budget_counters` row — correct under concurrency but a throughput ceiling at
   very high RPS (all requests contend on one row). Mitigations:
   - Enable `HIERARCHICAL_BUDGETS=true` and route spend through sharded top-level
     `budget_nodes` (see Rollout §5) so contention spreads across node rows.
   - For flat-only deploys at high RPS, split traffic by `project_id` (separate
     Ai-Guard instances) or accept the global row as the serializing cap until
     hierarchical mode is enabled.
   - Benchmark before/after with [`docs/deployment/benchmarks.md`](../deployment/benchmarks.md).
2. **Soft tenant isolation (default path).** Isolation is by `project_id` and
   optional `tenant_id` on a shared schema; hard boundaries require
   `DB_RLS_ENABLED=true` plus a non-owner DB role, or separate deployments per
   tenant.

## Historical context (pre-0.0.0)

Before the hierarchical rollout, caps existed only at `user_type` (daily),
`feature` (monthly), and one global row — with no org → dept → team nesting.
That flat path remains the **default**; hierarchical budgets are opt-in via
`HIERARCHICAL_BUDGETS=true`.

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

1. ~~Ship `budget_nodes` + counter migration; keep the flat path as the
   default.~~ **Done** — `0011_budget_nodes`, `modules/budgets/repo.ts`.
2. ~~Atomic multi-level reserve/settle/release with a concurrency proof.~~
   **Done** — `budget-nodes.integration.test.ts` (exact admission against a
   shared ancestor cap; 3-level tree).
3. ~~Pure engine path-walk.~~ **Done** — `evaluateBudgetPath()` (`budgetPath.ts`),
   unit-tested; rule matches the DB `reservePath` upsert.
4. ~~Wire `/v1/chat` behind a flag.~~ **Done** — `HIERARCHICAL_BUDGETS=true`;
   requests carrying a `budgetNodeId` (from the body or the API key) resolve the
   path, `evaluateBudgetPath` pre-check → `reservePath` → `settlePath`/
   `releasePath`, with node-reservation leases (`budget_node_leases`) swept by
   maintenance. Flat path stays default. (`chat-hierarchical.integration.test.ts`)
5. ~~Shard the top counter + benchmark.~~ **Done** — `shard_count` on a node
   splits its counter into N rows (`cap/N` each); measured ~3.3× throughput,
   ~7× lower p95 locally (see [benchmarks](../deployment/benchmarks.md)).
6. ~~Tenant binding on keys + policy versions.~~ **Done** — keys carry
   `tenant_id` + `budget_node_id`; policy versions are per-tenant with one active
   version each and cross-tenant activation blocked (`policy-store` +
   `chat-hierarchical` tests).
7. ~~Per-request per-tenant policy resolution.~~ **Done** — `MULTI_TENANT_POLICY=true`
   (with `POLICY_STORE_ENABLED`) resolves each request against its tenant's active
   version via a TTL cache (`tenantResolver.ts`), invalidated on activation so a
   new version applies without a restart (`policy-tenant.integration.test.ts`).
8. ~~Opt-in Postgres RLS on `config_versions`.~~ **Done** — `DB_RLS_ENABLED=true`
   installs the policy at migrate time and sets `app.current_tenant` per
   transaction; verified against a real non-owner role
   (`rls-tenant.integration.test.ts`). See below.

### Postgres RLS (opt-in, defense-in-depth)

Application queries already scope by `tenant_id`. For belt-and-suspenders, set
**`DB_RLS_ENABLED=true`** — this is shipped (`db/rls.ts`), not just a snippet:

- `migrate` (with the flag) installs the policy on `config_versions`:

  ```sql
  ALTER TABLE config_versions ENABLE ROW LEVEL SECURITY;      -- ENABLE, not FORCE
  CREATE POLICY tenant_isolation ON config_versions
    USING      (tenant_id = current_setting('app.current_tenant', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true));
  ```

- The runtime (with the flag) runs every `config_versions` statement inside a
  transaction that sets `app.current_tenant` (`withTenantContext`), so reads,
  writes, and activation are all filtered by the policy.

It is kept **out of the auto-migration chain** because enabling it changes query
results for non-owner roles — so it never surprises a default deploy. Two operator
prerequisites remain, because they can't be shipped in code:

1. Run the app as a **non-owner** DB role — the table owner always bypasses RLS
   (`ENABLE`, not `FORCE`). Grant that role `SELECT/INSERT/UPDATE/DELETE` on
   `config_versions` (and `USAGE` on its sequence).
2. Point `DATABASE_URL` at that role for the API; keep migrations running as the
   owner.

The policy is **fail-closed**: with no `app.current_tenant` set, `current_setting`
is NULL and no rows match. Verified against a real non-owner role in
`rls-tenant.integration.test.ts`.

## Production deployment checklist

Use this when enabling multi-tenant or hierarchical features in a shared environment:

| Step | Setting / action | Why |
| --- | --- | --- |
| 0 | **`deployProfile: multitenant`** (Helm `values-multitenant.yaml`) or `AI_GUARD_DEPLOY_PROFILE=multitenant` | Wires policy store + per-tenant policy + RLS; flat budgets stay default |
| 1 | Issue **tenant-scoped API keys** (`tenantId` on each key) | Scopes usage, requests, and erasure to the tenant |
| 2 | Enable **`POLICY_STORE_ENABLED=true`** | Per-tenant policy versions instead of a single file |
| 3 | Enable **`MULTI_TENANT_POLICY=true`** | Each request evaluates its tenant's active policy |
| 4 | Set **`POLICY_CACHE_TTL_MS`** (e.g. 30000) | Bounds cross-replica activation delay |
| 5 | Enable **`DB_RLS_ENABLED=true`** + non-owner DB role | Defense-in-depth on `config_versions` |
| 6 | Run **`ai-guard doctor`** | Surfaces dev keys, missing OIDC audience, `RATE_LIMIT_FAIL_OPEN`, RLS gaps |
| 7 | Set **`OIDC_AUDIENCE`** when operator SSO is on | Never use `OIDC_AUDIENCE_OPTIONAL=true` outside local dev |
| 8 | Pin image digests + rotate bootstrap `keys:admin` key | See `.env.production.example` |

Flat budgets remain the default; set **`HIERARCHICAL_BUDGETS=true`** only after seeding
`budget_nodes` and binding `budgetNodeId` on keys or requests.

### Remaining polish

- ~~Extend usage/requests read endpoints with explicit tenant scoping~~ **Done**
  (0.0.0+): `request_logs.tenant_id` is stamped from the API key on every chat
  audit row; `/v1/usage` and `/v1/requests` filter by `tenant_id` when the key is
  tenant-bound (`tenant-read-scope.integration.test.ts`).
