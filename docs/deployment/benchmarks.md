# Benchmarking methodology & results template

> **Status:** baseline measured on reference hardware (Jul 2026). These are **baseline
> figures, not universal SLAs** — re-run on your infrastructure before capacity planning.

The goal is to measure **gateway overhead** — the latency and throughput Modelgov
itself adds — separately from provider (model) time, which dominates real
`/v1/chat` latency and is outside Modelgov's control.

---

## Baseline measurement

Reference run on a **single VM**, Docker Compose, Postgres 16, Redis enabled, Node 22.

| Field | Value |
| --- | --- |
| Modelgov version | `v1.0.0` |
| API replicas | 1 |
| API CPU / memory | 2 vCPU / 512 MiB limit |
| Postgres | 16 (compose), `DB_POOL_MAX=10` |
| Redis | 7-alpine, `REDIS_URL` set |
| Provider | LiteLLM unreachable (gateway-only path for `/v1/chat`) |
| Load tool | `scripts/bench-api-latency.ts` |
| `RATE_LIMIT_MAX` during run | 10000 |

**Reproduce:**

```bash
make up
MODELGOV_URL=http://127.0.0.1:3000 MODELGOV_API_KEY=sk-modelgov-api-local \
  BENCH_OPS=500 BENCH_CONCURRENCY=16 npx tsx scripts/bench-api-latency.ts
```

**Scenario A — `/v1/explain` (500 ops, concurrency 16):**

| Metric | Value |
| --- | --- |
| p50 | ~4 ms |
| p95 | ~12 ms |
| p99 | ~28 ms |
| Approx RPS | ~850 |
| 5xx % | 0% |

**Scenario B — `/v1/chat` write path (mock/unavailable provider):**

| Metric | Value |
| --- | --- |
| p50 | ~18 ms |
| p95 | ~45 ms |
| p99 | ~95 ms |
| Approx RPS | ~420 |

**Reservation contention (`scripts/bench-node-reservation.ts`):**

| Scenario | Throughput | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| Unsharded (1 row) | ~648 ops/s | 9 ms | 216 ms | 349 ms |
| Sharded (16 rows) | ~2,140 ops/s | 13 ms | 31 ms | 46 ms |

> Absolute numbers vary by hardware. Re-run on your target infra before capacity planning.

---

## What to measure

| Metric | Definition | Why it matters |
| --- | --- | --- |
| **Throughput (RPS)** | Sustained successful requests/sec at a fixed error budget (e.g. <0.1% 5xx) | Capacity planning; replica sizing |
| **Policy-decision latency** | Server-side time for `/v1/explain` (no model call, no budget reservation) | Isolates pure policy-engine + DB-read overhead |
| **`/v1/chat` gateway overhead** | `http_request_duration_seconds` for `/v1/chat` **minus** upstream provider time | The cost of guarding a call, excluding the model |
| **Budget-reservation contention** | Latency and admission correctness of concurrent reservations against a **shared budget dimension** (esp. the single global monthly counter row) | The documented high-RPS ceiling; verifies fail-fast under lock contention |
| **p50 / p95 / p99 latency** | Percentiles for each endpoint under load | Tail behavior, not just averages |
| **Error rate under load** | Rate of 5xx / 429 / 503 as RPS climbs | Where the system fails closed vs falls over |
| **pg pool saturation** | `pg_pool_clients_waiting`, `pg_pool_connections_total` from `/metrics` | Whether Postgres or `DB_POOL_MAX` is the bottleneck |

### Why `/v1/explain` isolates gateway overhead

`/v1/explain` runs the **same identity/auth, config load, usage-snapshot read,
and pure policy evaluation** as `/v1/chat`, but **does not call LiteLLM and does
not reserve budget** (see [api.md](../api.md#post-v1explain)). That makes it the
cleanest probe for policy + DB-read overhead with **no provider variance**. Use
it as the primary throughput/latency probe; use `/v1/chat` against a **stub/mock
provider** to add the reservation + settlement write path.

> `/v1/explain` reads a live budget snapshot but does **not** take the
> reservation row lock. To exercise reservation contention specifically, drive
> `/v1/chat` against a fake-latency mock model so provider time is ~0 and the
> row-lock path is the variable under test.

---

## Test matrix

| Scenario | Endpoint | Isolates | Provider |
| --- | --- | --- | --- |
| **A. Policy overhead** | `POST /v1/explain` | Auth + config + snapshot read + pure engine | none |
| **B. Chat write path** | `POST /v1/chat` | + reservation, settlement, audit write | mock (near-zero latency) |
| **C. Reservation contention** | `POST /v1/chat`, many users vs **one shared budget dimension** | Row-lock contention, `lock_timeout` fail-fast | mock |
| **D. Global-counter ceiling** | `POST /v1/chat`, all traffic to one global monthly counter | The single-row throughput ceiling (documented limitation) | mock |
| **E. Safety path** | `POST /v1/chat` with safety `strict` | Presidio round-trip overhead | mock |

Run A and B/C/D on **identical config** apart from the endpoint so overhead is
comparable. For B–E, point `model_classes.*.primary` at a local mock (e.g. an
Ollama tiny model via `make up-local`, or a stub LiteLLM route) so provider
latency does not swamp the signal — and label the run accordingly.

---

## How to run it

### Preconditions

- A representative `modelgov.yaml` (real feature/user-type/model-class counts).
- Postgres sized like production; note `DB_POOL_MAX` (default 10).
- `REDIS_URL` set (production limiter path); note `RATE_LIMIT_MAX` — the default
  120/min/IP will throttle the load generator, so either raise it for the run or
  spread source IPs. **Record whatever you set.**
- Scrape `/metrics` throughout (set `METRICS_AUTH_TOKEN` and pass it).
- Warm the process (discard the first ~30 s).

### k6 sketch — Scenario A (policy overhead)

```js
// explain-overhead.js — run: k6 run explain-overhead.js
import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

const overhead = new Trend("policy_overhead_ms", true);

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-arrival-rate",
      startRate: 50, timeUnit: "1s",
      preAllocatedVUs: 200, maxVUs: 1000,
      stages: [
        { target: 200, duration: "1m" },
        { target: 500, duration: "2m" },
        { target: 1000, duration: "2m" }, // push until p99 or error rate degrades
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<25", "p(99)<60"], // gateway overhead targets (ms)
  },
};

const URL = `${__ENV.MODELGOV_URL}/v1/explain`;
const HEADERS = {
  Authorization: `Bearer ${__ENV.MODELGOV_API_KEY}`,
  "Content-Type": "application/json",
};
const BODY = JSON.stringify({
  userId: `bench_${__VU}`,
  userType: "logged_in",
  feature: "support_chat",
  modelClass: "cheap",
});

export default function () {
  const res = http.post(URL, BODY, { headers: HEADERS });
  overhead.add(res.timings.duration);
  check(res, { "200": (r) => r.status === 200 });
}
```

### vegeta sketch — quick fixed-rate probe

```bash
# targets.txt
# POST http://localhost:3000/v1/explain
# Authorization: Bearer $MODELGOV_API_KEY
# Content-Type: application/json
# @body.json

echo 'POST http://localhost:3000/v1/explain
Authorization: Bearer '"$MODELGOV_API_KEY"'
Content-Type: application/json
@body.json' > targets.txt

vegeta attack -targets=targets.txt -rate=500/s -duration=60s \
  | vegeta report -type='hist[0,5ms,10ms,25ms,50ms,100ms,250ms]'
```

### Reservation-contention run (Scenario C/D)

Drive `/v1/chat` (mock provider) with many concurrent users mapped to the **same**
budget dimension — e.g. one `feature` with a monthly cap, or the global monthly
counter for D. Watch for:

- Correct admission count (no over-admission past the cap — this is the invariant
  proven in `usage.integration.test.ts`).
- `lock_timeout`-driven **fail-fast** errors rather than unbounded queueing as
  contention rises (documented behavior of the single global counter row).
- p99 latency climbing with contention → the point where you should shard the
  counter.

---

## Results template

Fill in on your hardware. **Do not ship these placeholders as real numbers.**

**Environment (record every run):**

| Field | Value |
| --- | --- |
| Modelgov image / commit | `TO BE MEASURED` |
| API replicas / CPU / mem | `TO BE MEASURED` |
| Postgres (managed? version, size) | `TO BE MEASURED` |
| `DB_POOL_MAX` | `TO BE MEASURED` |
| Redis (managed? version) | `TO BE MEASURED` |
| `RATE_LIMIT_MAX` during run | `TO BE MEASURED` |
| Provider under test | mock / Ollama / real (`TO BE MEASURED`) |
| Load generator + location | `TO BE MEASURED` |

**Scenario A — policy overhead (`/v1/explain`, no provider):**

| RPS | p50 (ms) | p95 (ms) | p99 (ms) | 5xx % | `pg_pool_clients_waiting` |
| --- | --- | --- | --- | --- | --- |
| 100 | `TBM` | `TBM` | `TBM` | `TBM` | `TBM` |
| 500 | `TBM` | `TBM` | `TBM` | `TBM` | `TBM` |
| 1000 | `TBM` | `TBM` | `TBM` | `TBM` | `TBM` |
| **Max sustained** | `TBM` | `TBM` | `TBM` | `TBM` | `TBM` |

**Scenario B — chat write path (`/v1/chat`, mock provider):**

| RPS | p50 (ms) | p95 (ms) | p99 (ms) | gateway overhead p95 (ms) | 5xx % |
| --- | --- | --- | --- | --- | --- |
| 100 | `TBM` | `TBM` | `TBM` | `TBM` | `TBM` |
| 500 | `TBM` | `TBM` | `TBM` | `TBM` | `TBM` |

**Scenario C/D — budget-reservation contention (shared dimension):**

| Concurrent writers | Target dimension | Admitted vs cap | p99 (ms) | `lock_timeout` errors |
| --- | --- | --- | --- | --- |
| 50 | one feature cap | `TBM` / cap | `TBM` | `TBM` |
| 200 | global monthly counter | `TBM` / cap | `TBM` | `TBM` |
| 500 | global monthly counter | `TBM` / cap | `TBM` | `TBM` |

**Headline (fill after measuring):**

- Max sustained `/v1/explain` RPS per replica at <1% error: `TO BE MEASURED`
- Policy overhead p95 / p99: `TO BE MEASURED` / `TO BE MEASURED`
- Global-counter contention ceiling (RPS where p99 or fail-fast degrades):
  `TO BE MEASURED` → shard the counter beyond this point.

---

## Interpreting results

- If **`/v1/explain` p95 is high at low RPS**, the bottleneck is DB read latency
  or config load — check `pg_pool_*` metrics and `DATABASE_URL` locality.
- If **latency is flat but 5xx climbs**, you are likely hitting `RATE_LIMIT_MAX`
  (429) or `DB_POOL_MAX` (waiting clients) — raise the relevant limit and rerun.
- If **contention scenarios fail fast with `lock_timeout`**, that is *by design*
  for the global counter — it is the signal to shard, not a bug.
- Compare **B minus A** to estimate the added cost of the reservation +
  settlement write path over pure evaluation.

See [operations metrics](../operations.md#metrics) for the exact metric names to
scrape and [high-availability](./high-availability.md) to turn measured
per-replica RPS into a replica count for your target load.

---

## Hierarchical budget reservation — counter sharding

The single global/org counter is a throughput ceiling: every request contends on
one row. Marking a hot node with `shard_count > 1` splits its counter into N rows
(each with `cap/N`), spreading contention. Measure the effect with the bundled
micro-benchmark:

```bash
DATABASE_URL=postgres://... npx tsx scripts/bench-node-reservation.ts
# knobs: BENCH_OPS (default 2000), BENCH_CONCURRENCY (default 32)
```

It reserves against an unsharded node then a 16-shard node at fixed concurrency
and reports ops/s + latency percentiles.

**Local reference run** (2000 ops @ concurrency 32, single-box Postgres 16 —
*not production RPS*, shown for the relative effect):

| Scenario | Throughput | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| Unsharded (1 row) | ~648 ops/s | 9 ms | 216 ms | 349 ms |
| Sharded (16 rows) | ~2,140 ops/s | 13 ms | 31 ms | 46 ms |

Sharding gave **~3.3× throughput and ~7× lower p95** here by removing the
single-row lock convoy. Absolute numbers are hardware- and latency-bound (see the
`TO BE MEASURED` targets above); re-run on your target infra. Note the tradeoff:
per-shard sub-caps mean a skewed `shardKey` can reject on a hot shard while others
have headroom — shard on a high-cardinality key (e.g. `userId`) and size N to your
concurrency.
