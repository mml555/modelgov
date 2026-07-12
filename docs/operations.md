# Operations guide

Run Modelgov in production on your own infrastructure.

For local development, start with the repo root command:

```bash
./setup
```

That path uses the built-in demo provider and requires no cloud keys. Use
`make start-cloud` only when you intentionally want local calls to reach
OpenAI/Anthropic through LiteLLM.

## Compose stacks

The repo ships six compose files. `simple` is the base; `local`, `cloud`, and
`dev.full` are overlays layered on top of it (the `modelgov up <mode>` CLI and
Makefile targets handle the layering); `production` and `ci-e2e` stand alone.

| File | Mode | Purpose |
| --- | --- | --- |
| `docker-compose.simple.yml` | `./setup`, `make start` | Zero-secret local stack with the built-in demo provider |
| `docker-compose.local.yml` | `make start-local` | Overlay: routes models to local Ollama (API bound to 127.0.0.1) |
| `docker-compose.cloud.yml` | `make start-cloud` | Overlay: real OpenAI/Anthropic keys through LiteLLM |
| `docker-compose.dev.full.yml` | `make start-full` | Overlay: adds Langfuse with **hardcoded dev secrets** — never layer over production |
| `docker-compose.production.yml` | `make up-prod` | Standalone hardened production stack (pinned images, healthchecks, boot guards) |
| `docker-compose.ci-e2e.yml` | CI only | End-to-end example stack used by `scripts/example-e2e-ci.sh` |

## Production checklist

- [ ] TLS termination (nginx, ALB, Cloudflare) in front of the API
- [ ] One bootstrap `keys:admin` key in `MODELGOV_API_KEYS`; issue all other keys via the [key store](#api-key-management)
- [ ] Managed Postgres with automated backups
- [ ] Pinned container images (see [Production deploy](#production-deploy))
- [ ] Provider keys in a secrets manager, not git
- [ ] `GET /ready` wired to load balancer health checks
- [ ] Log shipping from API container
- [ ] Review [SECURITY.md](../SECURITY.md)

## Multi-tenant production checklist

When running a shared deployment with tenant-bound API keys:

- [ ] `POLICY_STORE_ENABLED=true` and `MULTI_TENANT_POLICY=true` if each tenant has its own policy lineage
- [ ] `HIERARCHICAL_BUDGETS=true` when using nested org/dept/team budgets (see [multi-tenancy design](./design/multi-tenancy.md))
- [ ] `DB_RLS_ENABLED=true` plus a **non-owner** Postgres role for defense-in-depth on `config_versions`
- [ ] Issue tenant-scoped keys with `tenantId` — usage, request reads, and GDPR erasure are filtered to that tenant
- [ ] Platform-wide operators use keys **without** `tenantId` only when cross-tenant admin is intentional
- [ ] Set `OIDC_AUDIENCE` when operator SSO is enabled (`MODELGOV_PRODUCTION=true` enforces this at boot)

## Production deploy

### 1. Build the API image

```bash
docker build -t your-registry/modelgov-api:1.0.0 -f packages/api/Dockerfile .
docker push your-registry/modelgov-api:1.0.0
```

### 2. Configure policy

Copy [`modelgov.production.example.yaml`](../modelgov.production.example.yaml) → `modelgov.yaml` and customize:

- `project.name` — matches your app and scoped API key `projectId` when used
- `budgets` — global monthly cap and per-`user_type` limits
- `features` — one entry per SDK `feature` your apps will call
- `model_classes` — align `primary` / `fallback` with [`litellm_config.yaml`](../litellm_config.yaml)

### 3. Configure environment

Copy [`.env.production.example`](../.env.production.example) → `.env.production` and set:

- `MODELGOV_API_IMAGE` — your built image (immutable digest recommended)
- `POSTGRES_IMAGE`, `LITELLM_IMAGE`, `PRESIDIO_*_IMAGE`, `REDIS_IMAGE` — pinned digests
- `DATABASE_URL` — production Postgres (or use compose postgres with strong password)
- Provider and API keys

### 4. Launch

```bash
make up-prod    # uses docker-compose.production.yml + .env.production
make down-prod
```

Equivalent lower-level command:

```bash
docker compose -f docker-compose.production.yml --env-file .env.production up -d
```

For Kubernetes, use the **Helm chart** ([deploy/helm/modelgov](../deploy/helm/modelgov/README.md)) — it templates the API (with a pre-upgrade migration hook), LiteLLM, Redis, and optional Presidio/Postgres/Ingress from values. Raw manifests are also available in [deploy/k8s/README.md](../deploy/k8s/README.md).

```bash
helm install modelgov ./deploy/helm/modelgov -n modelgov --create-namespace \
  --set image.repository=ghcr.io/your-org/modelgov-api --set image.tag=v1.7.1 \
  --set secret.aiGuardApiKey=... --set secret.databaseUrl=postgres://...
```

### 5. Verify

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3000/ready
```

Use **`/ready`** for load balancer readiness. It gates on the database and reports LiteLLM/Presidio status when configured.

## Health endpoints

| Endpoint | Checks | Use for |
| --- | --- | --- |
| `/health` | Process only | Liveness |
| `/ready` | Database gates readiness; LiteLLM + Presidio are reported if configured | Readiness / traffic routing |

## API key management

Static keys in `MODELGOV_API_KEYS` still work and are the recommended way to seed
**one** bootstrap key with the `keys:admin` permission. Every other key should be
issued from the **Postgres-backed key store**, so you can rotate and revoke live
without redeploying the fleet.

| Env | Default | Effect |
| --- | --- | --- |
| `API_KEYS_DB_ENABLED` | `true` | Consult the DB key store when no static key matches, and mount `/v1/admin/keys` |
| `API_KEY_CACHE_TTL_MS` | `10000` | How long a resolved key is cached in-process. Bounds how long a revoked key could still be accepted; mutations via the admin API clear the cache immediately on the handling replica. Other replicas converge within this TTL — use a low value (e.g. 10s) in production so revocation takes effect fleet-wide within seconds |

**Revocation latency:** `keys revoke` / `POST .../revoke` takes effect immediately on the replica that handles the admin call (its cache is cleared). Other API replicas may honor a revoked key until their in-process cache entry expires (`API_KEY_CACHE_TTL_MS`). For emergency revocation, lower the TTL temporarily or restart replicas after revoke.

Only the SHA-256 hash of each secret is stored — the plaintext is returned **once**
at create/rotate time and is never retrievable again.

Manage keys with the CLI (point `MODELGOV_API_KEY` at a `keys:admin` key):

```bash
modelgov keys create --name checkout-svc --permissions chat:create --project checkout
modelgov keys list
modelgov keys rotate <id>     # old secret stops working immediately
modelgov keys revoke <id>
```

Or over HTTP — `POST /v1/admin/keys`, `GET /v1/admin/keys`,
`POST /v1/admin/keys/{id}/rotate`, `POST /v1/admin/keys/{id}/revoke` (all require
`keys:admin`). See [HTTP API](./api.md).

## Operator SSO (OIDC) & RBAC

Human/automation access to the control plane can authenticate with a JWT from your
corporate IdP instead of an API key. When `OIDC_ISSUER` + `OIDC_JWKS_URI` are set,
a bearer token with JWT shape is verified against the IdP's JWKS (signature,
issuer, audience, expiry), then its roles/groups claim is mapped to **operator
roles**, which expand to permissions. Application traffic keeps using API keys.

| Env | Purpose |
| --- | --- |
| `OIDC_ISSUER` | Expected `iss` (from your IdP) |
| `OIDC_JWKS_URI` | IdP JWKS endpoint (from its discovery doc) |
| `OIDC_AUDIENCE` | Expected `aud` (recommended) |
| `OIDC_ROLES_CLAIM` | Claim holding roles/groups (default `roles`) |
| `OIDC_NAME_CLAIM` | Claim used as display name (default `sub`) |
| `OIDC_ROLE_MAP` | JSON mapping IdP group → Modelgov role(s) |
| `OIDC_TENANT_CLAIM` | Name of the token claim that binds the operator to a tenant. An operator is tenant-bound only when this var is set **and** the named claim is present and non-empty on their token; otherwise the operator is unbound and needs the `tenant:switch` permission to scope another tenant (see below). |

Built-in operator roles (least privilege):

| Role | Permissions |
| --- | --- |
| `viewer` | `usage:read`, `requests:read` |
| `finops` | `viewer` + `audit:read` |
| `key-admin` | `keys:admin` + reads |
| `policy-admin` | `policy:read`, `policy:write` + reads (authors versions; intentionally **cannot** approve) |
| `policy-approver` | `policy:read`, `policy:approve` + reads (approves/rejects proposed versions) |
| `owner` | everything |

When `POLICY_APPROVAL_REQUIRED=true`, a saved policy version is `proposed` and
can only be activated after a **different** operator holding `policy:approve`
approves it (self-approval is rejected). Keep `policy:write` and `policy:approve`
on separate roles/people so the two-person rule has teeth.

**Cross-tenant access (multi-tenant deployments):** scoping a request to another
tenant via the `X-Modelgov-Tenant` header requires the `tenant:switch`
permission, which only `owner` holds by default (breaking change in 1.2.0). An
OIDC operator is unbound unless `OIDC_TENANT_CLAIM` is set, so without either
`tenant:switch` or that claim an SSO operator is confined to the default
partition. Grant `tenant:switch` deliberately — it is the platform-wide escape
hatch.

Example: map an Okta/Entra group to `owner`:

```bash
OIDC_ISSUER=https://login.example.com/
OIDC_JWKS_URI=https://login.example.com/.well-known/jwks.json
OIDC_AUDIENCE=modelgov
OIDC_ROLE_MAP={"modelgov-admins":"owner","modelgov-finops":"finops"}
```

A verified token whose groups map to no role is authenticated but carries no
permissions, so protected routes answer `403` (not `401`).

## Secrets management

Any environment variable `X` can be supplied from a file via `X_FILE` — the API
reads the file at boot and populates `X`. This is the integration point for
**HashiCorp Vault Agent**, the **AWS/GCP/Azure Secrets Store CSI drivers**,
**Kubernetes Secrets**, and **Docker secrets**, all of which mount secret
material as files, so no cloud SDK is needed and long-lived secrets never sit in
the process environment or compose files.

```bash
# Vault Agent / CSI driver / k8s secret mounted at /run/secrets/*
DATABASE_URL_FILE=/run/secrets/database_url
MODELGOV_API_KEYS_FILE=/run/secrets/api_keys
LITELLM_MASTER_KEY_FILE=/run/secrets/litellm_key
OPENAI_API_KEY_FILE=/run/secrets/openai_key   # provider keys too
```

An explicitly-set `X` wins over `X_FILE`. A declared `X_FILE` that can't be read
is a **hard boot error** (fail fast rather than start without a credential).

## Backups

Back up the **Postgres** volume (or managed DB snapshots). Critical tables:

- `budget_counters` — spend state
- `request_logs` — audit trail
- `api_keys` — issued API keys (hashes + scoping); losing this locks out DB-issued keys
- `idempotency_keys` — short-lived; less critical

Restore procedure: restore DB snapshot → restart API → verify `/ready`.

## Scaling

| Concern | v1 guidance |
| --- | --- |
| **API replicas** | Supported — set `REDIS_URL` so rate limits are shared |
| **Rate limits** | In-memory per instance without Redis; set `REDIS_URL` (included in production compose) for shared limits across replicas |
| **Budget counters** | Centralized in Postgres — safe across replicas |
| **Migrations** | Run **one** migrator on deploy; avoid N containers racing `migrate.js` |
| **LiteLLM** | Single instance SPOF in default compose — add HA LiteLLM for high traffic |

For multiple API replicas, run migrations as a separate init job:

```bash
docker run --rm --env-file .env.production your-registry/modelgov-api:1.0.0 node dist/migrate.js
```

Then start API containers with `CMD ["node", "dist/index.js"]` (override default migrate+start).

## Maintenance

The API runs background cleanup when `MAINTENANCE_ENABLED=true` (default on):

- Stale idempotency `processing` rows older than `IDEMPOTENCY_STALE_MS` (default **15m**)
- Orphaned budget `reserved_usd` from worker crashes, via reservation leases older than `RESERVATION_STALE_MS` (default **15m**, aligned with idempotency)

When `REDIS_URL` is set, rate limiting **fails closed** if Redis is unavailable (requests are rejected rather than bypassing limits).

## Budget alerts

When global spend (used + reserved) crosses `alert_at_percent` in `modelgov.yaml`:

1. The API logs a structured warning **once per calendar month** (deduped in Postgres)
2. If `BUDGET_ALERT_WEBHOOK_URL` is set, it **POSTs once per calendar month** on the same dedupe claim

Webhook payload:

```json
{
  "event": "budget.alert",
  "scope": "global_monthly",
  "windowStart": "2026-06-01",
  "globalSpendUsd": 85.5,
  "alertThresholdUsd": 80,
  "alertAtPercent": 80,
  "monthlyCapUsd": 100,
  "sentAt": "2026-06-30T12:00:00.000Z"
}
```

If `BUDGET_ALERT_WEBHOOK_SECRET` is set, the request includes
`X-Modelgov-Signature: sha256=<hmac-sha256-hex>` over the JSON body.

## Docker image

Build locally:

```bash
make build-image
# or: scripts/build-api-image.sh ghcr.io/your-org/modelgov-api:1.0.0
```

CI publishes to **GitHub Container Registry** on version tags (`v*`) and on every
push as a commit-SHA tag. There is **no floating `:latest` tag** — pin an
immutable reference in production:

```text
# Release tag (preferred)
ghcr.io/<owner>/<repo>/modelgov-api:v1.7.1

# Or commit SHA (also published on each build)
ghcr.io/<owner>/<repo>/modelgov-api:<git-sha>

# Best: resolve the tag to a digest and set MODELGOV_API_IMAGE=...@sha256:...
docker buildx imagetools inspect ghcr.io/<owner>/<repo>/modelgov-api:v1.7.1
```

Production without a registry:

```bash
# .env.production
MODELGOV_API_IMAGE=modelgov-api:local
BUILD_LOCAL_IMAGE=true
make up-prod
```

## Local Ollama

```bash
ollama pull llama3.2:1b
ollama pull llama3.2:3b
make start-local
```

API on port **3080**. No cloud provider keys required.

## Observability

| Mode | Traces |
| --- | --- |
| `observability.provider: none` | Postgres `request_logs` only |
| `make start-full` / Langfuse | UI at :3001 |
| `observability.provider: otel` | OTLP/HTTP spans to any OpenTelemetry collector |

For OpenTelemetry, set `OBSERVABILITY_PROVIDER=otel` and
`OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4318` (optionally
`OTEL_SERVICE_NAME`). One span per chat is exported with feature / decision /
model / cost / token attributes — so OTel-standardized shops (Datadog, Grafana
Tempo, Honeycomb via a collector) aren't locked to Langfuse. Export is
best-effort and never blocks or fails a request.

**SIEM & alerting:** the API logs structured JSON (pino) — ship the container
logs plus the tamper-evident `/v1/admin/audit` trail to Splunk/Datadog. Budget
threshold breaches POST to `BUDGET_ALERT_WEBHOOK_URL` (HMAC-signed); point it at
Slack/PagerDuty-compatible endpoints for alert routing.

Set `OBSERVABILITY_CAPTURE_CONTENT=false` in production unless you need prompt logging in Langfuse.

Set `IDEMPOTENCY_CAPTURE_CONTENT=false` (default) so model completions are not stored in the idempotency table at rest — replays then return the response envelope with empty `message.content`.

## Metrics

Prometheus metrics are exposed at `GET /metrics` (`METRICS_ENABLED=true`, default on): request rate/errors/latency (`http_requests_total`, `http_request_duration_seconds`), pg pool saturation (`pg_pool_connections_total` / `_idle`, `pg_pool_clients_waiting`), Node process defaults, and domain (business) counters: `modelgov_chat_requests_total{feature,decision,status}`, `modelgov_chat_cost_usd_total{feature}`, `modelgov_chat_fallbacks_total{feature}`, `modelgov_budget_blocks_total{feature}`, and `modelgov_safety_blocks_total{feature}`.

In production, metrics must be protected with `METRICS_AUTH_TOKEN` unless you explicitly set `METRICS_ALLOW_PUBLIC=true` for a private scrape network with external access controls. Prometheus scrapes with `Authorization: Bearer <token>`.

Alert on: 5xx rate, p95 of `http_request_duration_seconds`, sustained `pg_pool_clients_waiting > 0`, budget-block rate (`rate(modelgov_budget_blocks_total[5m])`), and provider-fallback rate (`rate(modelgov_chat_fallbacks_total[5m])`).

Logs are structured JSON (pino). Set verbosity with `LOG_LEVEL` (`fatal|error|warn|info|debug|trace|silent`, default `info`). Every log line, the `requestId` in error responses, and the `x-modelgov-request-id` response header share one id per request (`reqId` in logs), so a client-reported id pivots straight to that request's logs.

## Health vs readiness

- `GET /health` — **liveness**, in-process only (never touches the DB). Point a k8s `livenessProbe` here; a DB blip must not restart pods.
- `GET /ready` — **readiness**, gates on the database only. LiteLLM/Presidio health is reported in the body but does not flip readiness (they fail closed per request), so a transient upstream blip won't deschedule the fleet. Point `readinessProbe` / the LB health check here.

## Data retention

`request_logs` is pruned by the maintenance sweep down to `REQUEST_LOG_RETENTION_MS` (default 30 days), in batches. The sweep runs on a single replica per tick (elected via a Postgres advisory lock); idempotency keys and reservation leases are swept on the same tick.

## Networking & TLS

- Terminate TLS at a proxy/LB in front of the API (there is no built-in TLS). Set `TRUST_PROXY` to your proxy's IP/CIDR list so client IPs and rate-limit buckets are real and can't be spoofed via `X-Forwarded-For`.
- Set `DATABASE_SSL=verify-full` (with `DATABASE_SSL_CA`) whenever Postgres is remote/managed.
- Migrations serialize across replicas via a Postgres advisory lock, so the default image entrypoint (`migrate && start`) is safe even when scaling up.

## Upgrades

1. Backup Postgres
2. Build and push new API image
3. Run migrations (`node dist/migrate.js`)
4. Rolling restart API containers
5. Smoke test `POST /v1/chat` and `GET /v1/usage`

## Known limitations (v1)

- No hosted SaaS — self-host only
- Single `modelgov.yaml` per deployment
- `user_daily` and `feature_monthly` budget counters are partitioned by `project_id` (from the API key or `modelgov.yaml` `project.name`); global monthly remains one deployment-wide counter
- **Streaming (SSE)** — `/v1/chat` supports `stream: true` (see [HTTP API](./api.md#streaming-stream-true)). Constraints: output PII protection must be off for the feature, no `Idempotency-Key`, and no mid-stream provider fallback. Non-streaming requests settle cost after the call as before.
- **Global budget is a single counter row** — correct under concurrency (atomic, cap-safe) but a throughput ceiling at very high RPS. A per-transaction `lock_timeout` makes contention fail fast rather than pile up; shard the counter if you outgrow it.
- **Fallback cost is pre-reserved** — when the primary provider fails, the API tops up the reservation to the fallback model's estimate before calling it, so caps are not marginally overshot on that path. Actual cost can still exceed the estimate if LiteLLM reports a higher real cost.
- **Rate limiting requires Redis in multi-replica mode and fails closed by default** — a Redis outage rejects `/v1/chat` (429) unless `RATE_LIMIT_FAIL_OPEN=true`. The atomic budget reserve remains the real spend guard.
- Budget windows are attributed by UTC day/month; a request spanning UTC midnight books to the window it reserved in.
- Reservation sweeper TTL defaults to 15m; very slow requests (>TTL) may see a duplicate reservation attempt after cleanup

See [Architecture](./ARCHITECTURE.md) for design details.
