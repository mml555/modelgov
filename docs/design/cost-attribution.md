# Cost attribution & correlation — design & status

Lets operators answer **"what did *this* business transaction cost?"** — where
a transaction (a "review", a document, a support case) fans out into many
gateway calls, and sometimes into non-LLM APIs Modelgov never sees. Today the
per-request cost and free-form tags are already captured; what's missing is a
way to *group* calls under one business key and to *query/aggregate* by it.

> **Status:** built. Migration `0028_request_correlation.sql` adds a nullable
> `correlation_id` column (+ partial btree index); the write path stamps it from
> `ctx.requestId` on every chat/embeddings audit row. Reads are always on —
> `GET /v1/requests?correlationId=` and `GET /v1/usage/transactions`. External
> non-LLM cost ingestion (`POST /v1/usage/external`, permission `usage:write`)
> is enabled by configuring `EXTERNAL_COST_SOURCES`; unset = fails closed. No
> separate feature flag: the surfaces are additive and harmless until used.

## Motivation (from customer notes)

A customer running a mixed AI pipeline (LLM calls **plus** Azure Document
Intelligence / OCR) reported three homegrown workarounds:

1. **Azure DI costs tracked locally** — Modelgov governs LLM APIs only, so
   non-LLM spend is invisible to it.
2. **An `ai_usage_events` SQLite table** — to correlate all spend (LLM + Azure)
   under one "review".
3. **An admin UI at `/admin/ai-costs`** — a per-review cost breakdown.

#2 and #3 are the near-term targets: they need no OCR proxy and no schema
change. #1 (governing non-LLM APIs) is tracked separately and only partially
addressed here (via cost ingestion).

## What exists today

- **Per-HTTP-call correlation id.** `x-request-id` (≤128 chars) is honored,
  unified with Fastify's `request.id` / pino `reqId`, and echoed as
  `x-modelgov-request-id`. Scope is a *single* HTTP call.
  (`packages/api/src/plugins/requestContext.ts:47`)
- **Free-form host tags, persisted with cost.** `metadata: Record<string,unknown>`
  (≤32 keys) on the chat/embeddings body → `host_metadata` JSONB on every
  `request_logs` row, beside `estimated_cost_usd` / `actual_cost_usd` / tokens.
  (`chat/schemas.ts:82`, `usage/auditLogRepo.ts:41`)

### Gaps

- **No query by tag.** `/v1/requests` filters only by
  `userId, feature, userType, status, reasonCode, since, projectId`; metadata
  comes back only on the single-record `/v1/requests/:id` (keyed by DB serial,
  not the client id). (`requests/routes.ts:18`)
- **No aggregation by a business key.** `/v1/usage/summary` groups cost by
  `feature` + `userType` only. (`usage/summaryReport.ts:17`)
- **`trace_tags` is not a host hook.** `TraceTags = { userId, feature,
  modelClass, policyDecision }` is written by the policy engine, not the caller.
  (`policy-engine/src/types.ts:293`)

## Design

### 1. A first-class correlation key

Promote a single business key into a typed, indexed column so it can be filtered
and grouped efficiently — **sourced from the existing `x-request-id` header**, no
new request-body field.

- **Chat / embeddings:** the correlation key is the `x-request-id` the caller
  already sends (≤128 chars). A client groups a transaction by sending the
  **same** `x-request-id` on every call in it. Sending nothing yields a fresh
  per-call UUID (no grouping) — correlation is opt-in.
  - Tradeoff accepted: `x-request-id` doubles as the per-call trace id
    (`ctx.requestId`, pino `reqId`, `x-modelgov-request-id`). Reusing it across
    calls deliberately trades per-call uniqueness for grouping.
- **New nullable column** `request_logs.correlation_id text`, written on every
  row from `ctx.requestId` (migration + `RequestLogRow.correlationId`).
- **External ingest** (§3) can't reuse a call header meaningfully, so its
  endpoint takes `correlationId` in the body (falling back to the `x-request-id`
  header for parity).
- `host_metadata` stays as-is for the other ≤32 tags (non-authoritative,
  unindexed).

*Alternative considered:* GIN-index `host_metadata` and filter on a caller-named
key. Rejected as the default — the key would be caller-defined (no stable name
to aggregate on across teams), and a JSONB GIN index is heavier and slower for
the single high-cardinality equality lookup this needs. A dedicated btree column
is the right tool. (We can still add GIN later for ad-hoc metadata search.)

### 2. Query surface

- `GET /v1/requests?correlationId=<id>` — all audit rows for one transaction,
  where `<id>` is the `x-request-id` the caller reused across the transaction
  (adds one filter to the existing list route; response shape unchanged). Named
  `correlationId` (not `requestId`) to avoid collision with the `:id` path param
  on `/v1/requests/:id`, which is the DB serial `req_<n>`.
- `GET /v1/usage/transactions?since=&limit=` — a **new** endpoint returning a
  top-N-by-cost list of `{ correlationId, requests, actualCostUsd,
  estimatedCostUsd, firstSeen, lastSeen }` rows. A dedicated endpoint rather
  than `/v1/usage/summary?groupBy=` on purpose: `summary` returns a single
  object today, and overloading it to sometimes return an array would break its
  response contract and its OpenAPI schema. `limit` is capped (default 50, max
  200) and the query is `since`-windowed so an unbounded group-by can't scan
  forever.

Both stay behind `usage:read` / `requests:read` and inherit the existing
project/tenant scoping.

### 3. Bridging non-LLM cost (#1, partial)

To let externally-tracked Azure DI spend roll up under the same transaction
*without* proxying DI:

- `POST /v1/usage/external` (new perm `usage:write`, **not** implied by
  `usage:read`) — `{ correlationId, source, feature, costUsd, userType?,
  quantity?, unit?, metadata? }`. Writes a `request_logs` row with
  `decision='external'`, `resolved_model=source` (e.g. `azure-di`), null tokens,
  and `actual_cost_usd=costUsd`.
- `feature` is **required** so external rows slot into the existing
  feature/userType dimensions instead of appearing as NULL-feature holes in
  `/v1/usage/summary`. `source` must be on a configurable allowlist
  (`EXTERNAL_COST_SOURCES=azure-di,textract,…`) so a typo can't silently create
  a new cost bucket. A per-row sanity cap (`EXTERNAL_COST_MAX_USD`, default
  e.g. 100) rejects fat-finger amounts.
- Because cost is caller-asserted, `decision='external'` keeps these rows
  **distinguishable** from metered LLM cost; the transaction rollup surfaces
  `externalCostUsd` separately from governed cost so reports never blur the two.
- These rows join the same correlation queries, so "cost per review" includes
  LLM **and** Azure DI in one number — retiring the customer's SQLite table and
  their `/admin/ai-costs` view.

This is *recording*, not *governing*: budgets/policy do not gate external spend.
Full non-LLM governance remains future work (see `multi-tenancy.md` scope
boundary and the vision-gateway roadmap).

### 4. Console

Once the API lands, the operator console gains a "By transaction" view on the
Usage page (backed by `groupBy=correlationId`) and a correlation filter on the
Requests explorer. No new backend beyond §2/§3.

## Non-goals

- Proxying or rate-limiting Azure DI / other non-LLM APIs.
- Enforcing budgets against externally-ingested cost.
- Distributed tracing / span trees (this is flat attribution, not APM).

## Decisions

1. **Ingestion trust** → resolved in §3: distinct `usage:write` permission,
   `source` allowlist, per-row max-cost guard, and `decision='external'` so
   asserted cost is always separable from metered LLM cost in reports.
2. **Correlation-id cardinality** → *no ingest-side cap.* Rejecting high
   cardinality would drop legitimate traffic; instead the read side is bounded
   (`/v1/usage/transactions` is top-N, `since`-windowed). `correlation_id`
   inherits the existing `request_logs` retention/pruning — no separate policy.
   Intended granularity (one id per business transaction) is documented, not
   enforced.
3. **Backfill** → *start fresh.* Old rows keep `correlation_id = NULL`; the
   migration ships dark with no data rewrite. Operators who want history can run
   a documented one-off `UPDATE … SET correlation_id = host_metadata->>'…'`.
4. **Arbitrary `host_metadata` key rollup (GIN path)** → *deferred.* Ship the
   promoted column first. Revisit a GIN index + arbitrary-key group-by only if a
   team declines to adopt `correlationId`.

## Open questions

- Resolved in the build: `/v1/usage/transactions` returns **both**
  `actualCostUsd` and `estimatedCostUsd`, ordered by
  `coalesce(NULLIF(sum(actual),0), sum(estimated))` — so in-flight transactions
  whose LLM rows haven't settled sort by their estimate instead of sinking to 0.
- Future: fold external cost into the per-feature `/v1/usage/summary` (today it
  appears only in the transaction rollup); and an optional GIN path to group by
  an arbitrary `host_metadata` key for teams that don't adopt `correlationId`.

## Rollout

- Migration `0028` adds the nullable `correlation_id` column + a partial btree
  index on `(tenant_id, correlation_id) WHERE correlation_id IS NOT NULL`; no
  data change, safe to ship dark.
- Read surfaces (`/v1/requests?correlationId`, `/v1/usage/transactions`) are
  always registered — additive and harmless with no config.
- External ingest is enabled by config, not a boolean flag:
  `EXTERNAL_COST_SOURCES` (allowlist; empty ⇒ endpoint returns 400) and
  `EXTERNAL_COST_MAX_USD` (per-row cap, default 100). `usage:write` is granted to
  `finops` + `owner`.
- Covered by `test/cost-attribution.integration.test.ts`: correlation stamping +
  filter, rollup math (LLM + external in one number, external broken out),
  external rows excluded from the LLM summary counts, `source` allowlist +
  max-cost rejection, `usage:write` gating, and the x-request-id fallback.
