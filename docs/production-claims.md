# Production claims

What Ai-Guard guarantees, what you must guarantee, and known limitations.

## What Ai-Guard guarantees (shipped software)

| Claim | Detail |
| --- | --- |
| **Policy before provider** | Every `/v1/chat` request is evaluated against `ai-guard.yaml` (or active policy version) before LiteLLM is called |
| **Atomic budget reservation** | Spend caps enforced via Postgres row locks — no over-admission past configured caps under normal operation |
| **Fail-closed production mode** | With `AI_GUARD_PRODUCTION=true`, known dev keys, unauthenticated metrics, and unsafe capture defaults refuse to boot |
| **Audit metadata** | Guarded requests fail closed if request audit metadata cannot be written; admin mutations commit only with a hash-chained admin audit row |
| **Versioned API contract** | `/v1/*` documented in committed `openapi.json`, published per release |
| **Admin APIs** | Keys, policy versions, audit log, usage — operable without SQL |

## What the host application must guarantee

| Responsibility | Owner |
| --- | --- |
| End-user authentication | Your app |
| Mapping users to `userId` / `userType` | Your app |
| TLS to Ai-Guard | Your infra |
| API key storage in app servers | Your app |
| Correct `feature` name per call site | Your app |

Ai-Guard is **not** a user identity provider.

## What infrastructure must guarantee

| Responsibility | Owner |
| --- | --- |
| Postgres availability, backups, TLS | Operator |
| Redis availability (multi-replica) | Operator |
| LiteLLM / provider connectivity | Operator |
| Ingress TLS certificates | Operator |
| Network segmentation | Operator |
| HA / multi-AZ | Operator — see [high-availability.md](./deployment/high-availability.md) |

## Known limitations

| Limitation | Detail |
| --- | --- |
| **Global counter throughput** | Single monthly global counter row caps RPS — shard hot nodes (`shard_count`) for higher throughput |
| **Not a SaaS** | No vendor-hosted control plane; you operate all components |
| **Provider latency dominates** | `/v1/chat` p99 includes model time; use `/v1/explain` to measure gateway overhead |
| **Policy store opt-in** | File-based config is default; dynamic policy requires `POLICY_STORE_ENABLED=true` |
| **HA is operator-managed** | Software supports replicas + Redis; you provision managed DB/Redis/LB |
| **Downgrade** | Unsupported after forward migrations — restore from backup |
| **Content in logs** | Off by default; enabling capture requires explicit production override |

## Unsupported assumptions

- Ai-Guard as the only security layer (you still need app auth, network policy, secrets management)
- Floating `:latest` image tags in production
- Running without Postgres backups
- Multi-tenant hard isolation on a single file-config deployment without separate keys/tenants

## Benchmark baseline

Published baseline numbers (not universal SLAs) live in [deployment/benchmarks.md](./deployment/benchmarks.md). Re-run on your hardware before capacity planning.

## Related docs

- [production-deploy.md](./production-deploy.md) — blessed install path
- [failure-semantics.md](./failure-semantics.md) — dependency failure behavior
- [enterprise-readiness-checklist.md](./enterprise-readiness-checklist.md) — pre-GA checklist
