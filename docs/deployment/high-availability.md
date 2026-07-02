# High-availability reference architecture

The default deploy modes (`make up`, `make up-prod`) run **single instances** of
LiteLLM, Postgres, Presidio, and Redis. That is fine for evaluation and low
traffic, but the [Operations guide](../operations.md#scaling) and
[failure semantics](../failure-semantics.md) call out the single points of
failure (SPOFs) explicitly:

- **LiteLLM** is a single instance in the default compose — every model call
  transits it.
- **Postgres** is a single instance — budget reservation and audit require it.
- **Presidio** analyzer/anonymizer are single instances — safety fails closed
  when they are down (`503 safety_unavailable`).

This document describes an HA reference topology that removes those SPOFs. The
**API and Redis behavior described here already ship** (stateless API replicas,
shared Redis rate limiting, atomic Postgres budget reservations, the migration
init-job pattern). Running **multiple LiteLLM / Presidio replicas behind a load
balancer** and **Postgres with a managed primary + replica** is an operational
deployment choice — the components support it, but Ai-Guard does not ship a
turnkey HA chart. Treat the manifests here as a pattern to adapt.

---

## Design principles

| Principle | How Ai-Guard supports it |
| --- | --- |
| **Stateless API tier** | The API holds no durable state; all spend/audit state lives in Postgres. Scale horizontally by adding replicas. |
| **Shared rate-limit state** | Set `REDIS_URL` so the limiter counter is shared across replicas rather than per-instance in-memory. |
| **Atomic spend enforcement** | Budget reservations use Postgres row locks — correct across any number of API replicas. |
| **Fail closed on policy/safety** | A dependency blip rejects the request rather than allowing an unguarded/uncounted model call. |
| **One migrator, not N** | Run schema migration as a **single init job**; do not let N API replicas race `migrate.js`. (The default image entrypoint also serializes via a Postgres advisory lock, so racing is safe but wasteful.) |

---

## Topology

```text
                                  Internet / VPC ingress
                                          │
                                   ┌──────▼───────┐
                                   │  TLS / L7 LB  │  (ALB, nginx, Cloudflare)
                                   │  health: /ready
                                   └──────┬───────┘
                                          │
                 ┌────────────────────────┼────────────────────────┐
                 │                         │                         │
          ┌──────▼──────┐          ┌──────▼──────┐          ┌──────▼──────┐
          │ API replica │          │ API replica │          │ API replica │   (N stateless,
          │  (stateless)│          │  (stateless)│          │  (stateless)│    HPA-scaled)
          └──┬───┬───┬──┘          └──┬───┬───┬──┘          └──┬───┬───┬──┘
             │   │   │                │   │   │                │   │   │
   ┌─────────┘   │   └────────┐  (all replicas share the same backends)
   │             │            │
   ▼             ▼            ▼
┌────────┐  ┌─────────┐  ┌──────────────┐
│ Redis  │  │Postgres │  │  Presidio     │
│ (rate  │  │ primary │  │  analyzer x M │◄─┐
│ limits,│  │  (RW)   │  │  anonymizer xM│  │ internal LB / Service
│ HA/    │  │    │    │  └──────────────┘  │ (round-robin)
│ mgd)   │  │    │ streaming replication   │
└────────┘  │    ▼    │                     │
            │Postgres │            ┌────────▼─────────┐
            │ replica │            │  LiteLLM x K      │  (behind internal LB)
            │  (RO,   │            │  (stateless proxy)│
            │ failover)│           └────────┬─────────┘
            └─────────┘                     │
                                            ▼
                              OpenAI / Anthropic / Gemini / Bedrock

        [init job, runs once per deploy]  ai-guard-migrate → Postgres primary
```

- **Load balancer** terminates TLS (there is no built-in TLS) and routes to API
  replicas using `GET /ready` as the health check. Set `TRUST_PROXY` to the LB
  CIDR so client IPs and rate-limit buckets are real.
- **API replicas** are identical and stateless. Kubernetes `Deployment` with an
  HPA, or N compose/ECS tasks. Liveness → `GET /health` (in-process, never
  touches the DB); readiness → `GET /ready` (DB-gated).
- **Redis** provides the shared rate-limit counter. Use a managed HA Redis
  (ElastiCache/Memorystore with replica + automatic failover) or Redis Sentinel.
  Rate limiting **fails closed** if Redis is unreachable unless
  `RATE_LIMIT_FAIL_OPEN=true`.
- **Postgres** is the correctness anchor. Use a managed HA offering (RDS
  Multi-AZ, Cloud SQL HA, Aurora) or a primary + streaming-replica pair with
  automated failover. The API needs a single read-write endpoint; point
  `DATABASE_URL` at the failover DNS/proxy (e.g. RDS Proxy). Set
  `DATABASE_SSL=verify-full` with `DATABASE_SSL_CA` for managed Postgres.
- **LiteLLM** runs as K stateless replicas behind an internal load balancer.
  This removes the documented LiteLLM SPOF. Point `LITELLM_BASE_URL` at the LB
  address. LiteLLM itself holds no Ai-Guard state.
- **Presidio** analyzer and anonymizer each run as M replicas behind an internal
  Service. Point `PRESIDIO_ANALYZER_URL` / `PRESIDIO_ANONYMIZER_URL` at the
  Service names.
- **Migration init job** runs `node dist/migrate.js` once per deploy and must
  complete before API replicas start serving. See
  [`deploy/k8s/migration-job.yaml`](../../deploy/k8s/migration-job.yaml).

> **Read-replica scope:** the API today issues its budget/audit reads and writes
> against a single `DATABASE_URL` (the primary). A read replica in this topology
> is for **failover and out-of-band analytics/reporting**, not automatic
> read-write splitting inside the API — Ai-Guard does not split reads to a
> replica in v1. Do not point `DATABASE_URL` at a read-only endpoint.

---

## Component-failure matrix

What happens when each component dies, and the recovery path. Behavior rows are
grounded in [failure-semantics.md](../failure-semantics.md); HA rows describe the
mitigation this topology adds.

| Component | Single-instance behavior (default) | Request impact in HA topology | Recovery |
| --- | --- | --- | --- |
| **One API replica** | N/A (single = full outage) | LB stops routing to it on `/ready` failure; other replicas absorb traffic | Restart/replace pod; HPA or scheduler reschedules |
| **All API replicas** | Full outage | Full outage | Investigate shared dependency (usually DB); roll back last deploy |
| **Postgres primary** | `500` on `/v1/chat`; `/ready` not ready; no spend/audit | Brief errors during failover, then managed replica is promoted; API reconnects | Managed HA auto-failover; verify `/ready` recovers; check for orphaned reservations (swept after `RESERVATION_STALE_MS`) |
| **Postgres replica** | N/A | No request impact (API uses primary) | Rebuild replica; failover target temporarily reduced |
| **Redis** | Rate limiter degrades to per-instance in-memory (no `REDIS_URL`) | With `REDIS_URL` set, limiter **fails closed** → `429` on `/v1/chat` unless `RATE_LIMIT_FAIL_OPEN=true`. Budget reserve still guards spend. | Redis failover/restart; consider `RATE_LIMIT_FAIL_OPEN=true` only if you accept unbounded RPS during Redis outages |
| **One LiteLLM replica** | N/A (single = provider outage) | Internal LB routes around it; K−1 replicas serve | Restart/replace; health-check the internal LB |
| **All LiteLLM** | `fallback` model attempted; if none/also-down → `502 provider_unavailable`, reservation released | Same, once all K are down | Restart LiteLLM tier; check provider credentials/quota |
| **Upstream provider (OpenAI etc.)** | `fallback` model class if configured, else `502` | Same | Provider-side; fallback model class absorbs single-provider outages |
| **One Presidio replica** | N/A | Service routes to healthy replicas | Restart/replace |
| **All Presidio (safety on)** | `503 safety_unavailable`, request blocked (fail closed) | Same, once all M down | Restart Presidio tier; safety stays closed until healthy |
| **Presidio (safety `dev`/off)** | No-op guard; not required | Same | N/A |
| **Langfuse** | Request proceeds; trace export best-effort (swallowed) | Same | Non-blocking; fix async |
| **Load balancer** | N/A (single LB = SPOF) | Use a managed/redundant LB (ALB is multi-AZ; run ≥2 nginx behind DNS/anycast) | Provider-managed or run redundant LB nodes |

Key invariant: **no failure mode allows an untracked or unbudgeted model call.**
Policy and safety fail closed; only observability (Langfuse) degrades open.

---

## Migration init-job pattern

Multiple API replicas must not race `migrate.js`. Two safe patterns:

1. **Init job (recommended for HA):** run one migration job to completion, then
   start API replicas with the start-only command. On Kubernetes:

   ```bash
   kubectl apply -f deploy/k8s/migration-job.yaml
   kubectl wait --for=condition=complete job/ai-guard-migrate -n ai-guard --timeout=120s
   kubectl apply -f deploy/k8s/deployment.yaml
   ```

   On compose/ECS, run the migrator as a one-shot task first:

   ```bash
   docker run --rm --env-file .env.production \
     your-registry/ai-guard-api:<tag> node dist/migrate.js
   ```

2. **Advisory-lock entrypoint (default image):** the default `migrate && start`
   entrypoint serializes migrations across replicas via a Postgres advisory
   lock, so scaling up is safe even without a separate job. The init job is
   still preferred at scale because it keeps schema changes out of the hot start
   path and gives a clear pre-flight gate.

Override the container command to `["node", "dist/index.js"]` on API replicas
when you use the init-job pattern.

---

## Target SLOs and assumptions

These are **reference targets** for a correctly provisioned HA deployment on your
own infrastructure. Ai-Guard ships no hosted SLA (self-host only); the
[commercial SLA template](../commercial/sla.md) is a starting point for teams
offering Ai-Guard as an internal platform.

| Objective | Target | Measured as |
| --- | --- | --- |
| API availability | **99.9%** monthly (≈43 min/month budget) | Fraction of `/ready` checks and `/v1/*` requests not returning 5xx from the gateway itself |
| Policy-decision latency (gateway overhead) | p95 **< 25 ms**, p99 **< 60 ms** | `/v1/explain` server-side latency, provider time excluded (see [benchmarks](./benchmarks.md)) |
| End-to-end `/v1/chat` latency | Dominated by provider + safety; gateway adds the overhead above | `http_request_duration_seconds` minus upstream time |
| Recovery from single-component failure | No manual action for API/LiteLLM/Presidio replica loss; DB failover < managed RTO | Component-failure matrix |

**Assumptions behind 99.9%:**

- Postgres runs as a managed HA service (Multi-AZ / regional) — this is the
  hardest dependency to make HA yourself and usually the availability floor.
- ≥3 API replicas across ≥2 availability zones, behind a multi-AZ LB.
- ≥2 replicas each of LiteLLM and Presidio behind internal load balancing.
- Redis is managed HA; you have decided your `RATE_LIMIT_FAIL_OPEN` posture.
- Upstream provider availability is **excluded** from the gateway SLO — a
  provider outage that exhausts your fallback model class is counted against
  the provider, not Ai-Guard. Configure a `fallback` in a different provider to
  survive single-provider outages.
- The single **global monthly budget counter row** is a throughput ceiling at
  very high RPS (documented limitation). A per-transaction `lock_timeout` makes
  contention fail fast; shard the counter if you outgrow it. This bounds
  achievable RPS, not availability.

**Not yet built / caveats:**

- The [Helm chart](../../deploy/helm/ai-guard/) ships HA-oriented defaults —
  ≥2 replicas, a PodDisruptionBudget, node+zone topology spread, hardened
  security contexts, and opt-in HPA / NetworkPolicy / ServiceMonitor. Provision
  the managed data tier (RDS Postgres + ElastiCache Redis, HA defaults) with the
  [AWS Terraform module](../../deploy/terraform/aws/), which can wire its outputs
  straight into the chart's `secret.existingSecret`.
- The API does not split reads to a Postgres replica; the replica is for
  failover/reporting only.
- Whether streamed (SSE, `"stream": true`) or buffered, a completion occupies a
  worker for its full duration — size replica count and `REQUEST_TIMEOUT_MS`
  accordingly.

See [benchmarks](./benchmarks.md) to size replicas from measured overhead, and
[disaster recovery](../runbooks/disaster-recovery.md) for backup/restore and
multi-region strategy.
