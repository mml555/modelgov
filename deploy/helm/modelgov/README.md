# Modelgov Helm chart

Turnkey Kubernetes install of the Modelgov gateway — the k8s companion to the
`create-modelgov` docker-compose scaffold.

## Install

**Single-tenant self-host** (flat budgets, one policy file):

```bash
helm install modelgov ./deploy/helm/modelgov \
  -f deploy/helm/modelgov/values-selfhost.yaml \
  --namespace modelgov --create-namespace \
  --set image.repository=ghcr.io/your-org/modelgov-api \
  --set image.tag=v1.2.0 \
  --set secret.aiGuardApiKey=$(openssl rand -hex 24) \
  --set secret.databaseUrl='postgres://user:pass@your-db:5432/modelgov' \
  --set-string secret.providerKeys.OPENAI_API_KEY=sk-...
```

**Azure OpenAI** (use `values-azure.yaml` for policy + LiteLLM wiring):

```bash
helm install modelgov ./deploy/helm/modelgov \
  -f deploy/helm/modelgov/values-selfhost.yaml \
  -f deploy/helm/modelgov/values-azure.yaml \
  ...
  --set-string secret.providerKeys.AZURE_API_KEY='...' \
  --set-string secret.providerKeys.AZURE_API_BASE='https://<resource>.openai.azure.com' \
  --set-string secret.providerKeys.AZURE_API_VERSION='2024-08-01-preview'
```

**SaaS multi-tenant control plane** (per-tenant policy + RLS — connect as a
non-owner DB role; see `values-multitenant.yaml`):

```bash
helm install modelgov ./deploy/helm/modelgov \
  -f deploy/helm/modelgov/values-multitenant.yaml \
  ...
```

Generic install (no profile overlay):

```bash
helm install modelgov ./deploy/helm/modelgov \
  --namespace modelgov --create-namespace \
  --set image.repository=ghcr.io/your-org/modelgov-api \
  --set image.tag=v1.2.0 \
  --set secret.aiGuardApiKey=$(openssl rand -hex 24) \
  --set secret.databaseUrl='postgres://user:pass@your-db:5432/modelgov' \
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
| Redis | in-cluster | shared rate limits across replicas; use managed Redis for HA |
| Presidio | in-cluster | required by the default `balanced` safety policy |
| Postgres | **off** | dev-only in-cluster; use managed Postgres in production |
| Ingress | off | enable + set `ingress.host` |

## Secrets & config

- **Secret** — provide `secret.existingSecret` (recommended: sync from Vault /
  CSI / Sealed Secrets), or let the chart create one from `secret.*`. Carries
  `MODELGOV_API_KEY`, `DATABASE_URL`, `LITELLM_MASTER_KEY`, optional
  `METRICS_AUTH_TOKEN`, optional Stripe billing keys (`secret.stripeSecretKey`
  → `STRIPE_SECRET_KEY`, `secret.stripeWebhookSecret` → `STRIPE_WEBHOOK_SECRET`;
  pair with a `billing:` section in the policy config), and provider keys
  (`secret.providerKeys`).
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
| `NetworkPolicy` (ingress to `:3000`; egress to DNS + deps + Postgres) | **on** | `networkPolicy.enabled=false` only when your CNI cannot enforce it |
| Prometheus Operator `ServiceMonitor` | off (needs the CRD) | `serviceMonitor.enabled=true` |

`readOnlyRootFilesystem` is verified against the image (a writable `emptyDir` is
mounted at `/tmp`; nothing else is written). Set `nodeSelector` / `tolerations`
/ `affinity` under `api.*` for placement.

### Pin images in production

The quick-start images use floating tags (`litellm:main-stable`,
`redis:7-alpine`, `presidio:*latest`, …). Set **`production: true`** and the
chart will **refuse to render** if any deployed image uses a floating tag —
forcing you to pin every image to a version or `@sha256` digest so a deploy
can't silently drift:

```yaml
production: true
image: { tag: v1.2.0 }                                   # already pinned
litellm: { image: "ghcr.io/berriai/litellm@sha256:…" }   # pin the rest
redis:   { image: "redis:7.4.1-alpine" }
presidio:
  analyzerImage: "mcr.microsoft.com/presidio-analyzer@sha256:…"
  anonymizerImage: "mcr.microsoft.com/presidio-anonymizer@sha256:…"
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
- Terminate TLS at the ingress. With `production=true`, metrics are rejected at
  render time unless `secret.metricsAuthToken` is set, `secret.existingSecret`
  contains `METRICS_AUTH_TOKEN`, or `api.metricsAllowPublic=true` is explicitly
  set for a private scrape network. If the chart creates the secret,
  `serviceMonitor.enabled=true` automatically wires the bearer token for
  Prometheus; with `secret.existingSecret`, set
  `serviceMonitor.bearerTokenSecret.name` to that secret.
- The default inline policy uses `balanced` safety, so Presidio is enabled by
  default. If you set `presidio.enabled=false`, also provide an inline config
  that does not use `balanced`/`strict` safety, or provide an existing ConfigMap
  whose safety dependencies you manage yourself.

See [operations](../../../docs/operations.md) and
[high-availability](../../../docs/deployment/high-availability.md).

## Deployment profiles

| Profile | Overlay | Budget path | Policy | When to use |
| --- | --- | --- | --- | --- |
| `selfhost` | `values-selfhost.yaml` | Flat (default) | Single `modelgov.yaml` file | One org, self-hosted gateway |
| `multitenant` | `values-multitenant.yaml` | Flat per tenant (hierarchy opt-in) | DB policy store + per-tenant versions + RLS | SaaS control plane |

Both profiles keep **`HIERARCHICAL_BUDGETS=false`** by default. Enable hierarchy
and `shard_count` on a tenant's top `budget_node` only when nested caps or
measured global-row contention require it (`docs/deployment/benchmarks.md`).

Set `deployProfile: selfhost|multitenant` (or `MODELGOV_DEPLOY_PROFILE` in
compose) and run `pnpm modelgov doctor production` to verify posture.
