# Ai-Guard Helm chart

Turnkey Kubernetes install of the Ai-Guard gateway — the k8s companion to the
`create-ai-guard` docker-compose scaffold.

## Install

```bash
helm install ai-guard ./deploy/helm/ai-guard \
  --namespace ai-guard --create-namespace \
  --set image.repository=ghcr.io/your-org/ai-guard-api \
  --set image.tag=v0.5.0 \
  --set secret.aiGuardApiKey=$(openssl rand -hex 24) \
  --set secret.databaseUrl='postgres://user:pass@your-db:5432/aiguard' \
  --set-string secret.providerKeys.OPENAI_API_KEY=sk-...
```

Then paste your production policy into `config.aiGuardYaml` (or point at an
existing ConfigMap) and `helm upgrade`.

## What it deploys

| Component | Default | Notes |
| --- | --- | --- |
| API (`Deployment` + `Service`) | 2 replicas | `/health` liveness, `/ready` readiness |
| Migration `Job` | on | pre-install/pre-upgrade **hook** — one migrator, not N replicas racing |
| LiteLLM | in-cluster | set `litellm.enabled=false` + `litellm.baseUrl` to use external |
| Redis | in-cluster | shared rate limits across replicas (HA); `redis.enabled=false` to skip |
| Presidio | **off** | enable for `balanced`/`strict` PII/injection enforcement |
| Postgres | **off** | dev-only in-cluster; use managed Postgres in production |
| Ingress | off | enable + set `ingress.host` |

## Secrets & config

- **Secret** — provide `secret.existingSecret` (recommended: sync from Vault /
  CSI / Sealed Secrets), or let the chart create one from `secret.*`. Carries
  `AI_GUARD_API_KEY`, `DATABASE_URL`, `LITELLM_MASTER_KEY`, optional
  `METRICS_AUTH_TOKEN`, and provider keys (`secret.providerKeys`).
- **Policy** — inline `config.aiGuardYaml` or `config.existingConfigMap`. The API
  pods roll automatically when the config checksum changes.

## Security & resilience (hardened defaults)

The chart ships enterprise-hardened defaults; no extra flags needed for the
baseline:

| Concern | Default | Value |
| --- | --- | --- |
| Non-root, no-priv-esc, read-only rootfs, drop ALL caps, `RuntimeDefault` seccomp | **on** | `api.podSecurityContext`, `api.containerSecurityContext` |
| Dedicated `ServiceAccount`, token not mounted (API never calls the k8s API) | **on** | `serviceAccount.*` |
| `PodDisruptionBudget` (survive drains/rollouts) | **on**, `minAvailable: 1` | `podDisruptionBudget.*` |
| Node + zone topology spread (survive a node/zone loss) | **on** | `api.topologySpreadConstraints` (auto) |
| Horizontal autoscaling (`autoscaling/v2` HPA) | off (needs metrics-server) | `autoscaling.enabled=true` |
| `NetworkPolicy` (ingress to `:3000`; egress to DNS + deps + Postgres) | off (needs enforcing CNI) | `networkPolicy.enabled=true` |
| Prometheus Operator `ServiceMonitor` | off (needs the CRD) | `serviceMonitor.enabled=true` |

`readOnlyRootFilesystem` is verified against the image (a writable `emptyDir` is
mounted at `/tmp`; nothing else is written). Set `nodeSelector` / `tolerations`
/ `affinity` under `api.*` for placement.

### Pin images in production

The quick-start dev images use floating tags (`litellm:main-stable`,
`redis:7-alpine`, `presidio:*latest`, …). Set **`production: true`** and the
chart will **refuse to render** if any deployed image uses a floating tag —
forcing you to pin every image to a version or `@sha256` digest so a deploy
can't silently drift:

```yaml
production: true
image: { tag: v0.5.0 }                                   # already pinned
litellm: { image: "ghcr.io/berriai/litellm@sha256:…" }   # pin the rest
redis:   { image: "redis:7.4.1-alpine" }
```

Provision the managed data tier (and skip in-cluster Postgres/Redis) with the
[Terraform module](../../terraform/aws/).

## Production notes

- Use **managed Postgres** (`postgres.enabled=false`) and set
  `secret.databaseUrl` to it. With in-cluster `postgres.enabled=true` (dev), set
  `migrations.enabled=false` — the pre-install migration hook runs before the
  in-cluster DB is ready, and the API self-migrates under an advisory lock.
- Keep `redis.enabled=true` for multiple API replicas (shared, fail-closed rate
  limits). The atomic budget reserve is the real spend guard regardless.
- Terminate TLS at the ingress; set `METRICS_AUTH_TOKEN` if `/metrics` is
  reachable beyond an internal scrape network.

See [operations](../../../docs/operations.md) and
[high-availability](../../../docs/deployment/high-availability.md).
