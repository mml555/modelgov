# Production deployment guide

> **Official production path:** Helm + managed Postgres + managed Redis + external TLS + pinned images.
>
> Docker Compose (`make up-prod`) is for small self-hosted / non-HA deployments.
> Local compose modes are for development and evaluation only.

This guide walks from empty infrastructure to a running production Modelgov deployment using the **recommended Helm path**.

---

## Deployment modes

| Mode | Command | Intended use |
| --- | --- | --- |
| `./setup` | `pnpm modelgov setup simple` | Zero-secret local dev |
| `make start-cloud` | `pnpm modelgov up cloud` | Local dev with real provider keys |
| `make start-full` | `pnpm modelgov up full` | Local dev with Langfuse |
| `make start-local` | `pnpm modelgov up local` | Local Ollama evaluation |
| `make up-prod` | `pnpm modelgov up prod` | Small self-hosted production (**not HA**) |
| **Helm** | See below | **Recommended enterprise production** |

---

## Required infrastructure

| Component | Requirement |
| --- | --- |
| **Kubernetes** | 1.27+ with ingress controller |
| **Postgres** | 16+, managed (RDS, Cloud SQL, Azure Database), TLS enabled |
| **Redis** | 7+, managed, reachable from API pods |
| **TLS** | Terminated at ingress / load balancer (cert-manager or cloud LB) |
| **Container registry** | Pull `ghcr.io/<org>/modelgov-api:v1.1.0` (pin digest in values) |
| **Secrets store** | K8s Secrets, Vault, or cloud secret manager for API keys and DB URL |

### Network diagram

```text
                    ┌─────────────────────────────────────┐
  Internet / VPC    │  TLS ingress (443)                  │
        │           │         │                           │
        ▼           │    ┌────▼─────┐   ┌──────────────┐  │
   Your apps ───────┼───▶│ Modelgov │──▶│ LiteLLM      │──┼──▶ OpenAI / Anthropic
   (SDK/HTTP)       │    │ API (×N) │   │ (in-cluster) │  │
                    │    └────┬─────┘   └──────────────┘  │
                    │         │                           │
                    │    ┌────▼─────┐   ┌──────────────┐  │
                    │    │ Postgres │   │ Redis        │  │
                    │    │ (managed)│   │ (managed)    │  │
                    │    └──────────┘   └──────────────┘  │
                    └─────────────────────────────────────┘
```

---

## Canonical install (Helm)

**One command path** after prerequisites are met:

```bash
helm upgrade --install modelgov deploy/helm/modelgov \
  --namespace modelgov --create-namespace \
  --set production=true \
  --set image.repository=ghcr.io/your-org/modelgov-api \
  --set image.tag=v1.1.0 \
  --set api.replicas=2 \
  --set-string api.extraEnv[0].name=MODELGOV_PRODUCTION \
  --set-string api.extraEnv[0].value=true \
  --set-string api.extraEnv[1].name=DATABASE_URL \
  --set-string api.extraEnv[1].value='postgres://...' \
  --set-string api.extraEnv[2].name=MODELGOV_API_KEY \
  --set-string api.extraEnv[2].value='from-secret' \
  --set redis.enabled=false \
  --set externalRedis.url='rediss://...' \
  --set postgres.enabled=false \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=modelgov.example.com
```

Copy [`deploy/helm/modelgov/values.yaml`](../deploy/helm/modelgov/values.yaml) into a private values file for your org; never commit secrets.

---

## Required environment variables

See [`.env.production.example`](../.env.production.example) for the full list. Minimum for production:

| Variable | Notes |
| --- | --- |
| `MODELGOV_PRODUCTION` | Must be `true` — enables fail-closed boot checks |
| `DATABASE_URL` | Managed Postgres connection string |
| `DATABASE_SSL` | `require` or `verify-full` (never `disable` for remote DB) |
| `MODELGOV_API_KEY` or `MODELGOV_API_KEYS` | Strong random secret; bootstrap admin key only with `ALLOW_BOOTSTRAP_ADMIN_KEY=true` |
| `MODELGOV_CONFIG` | Path to production `modelgov.yaml` (or enable policy store) |
| `LITELLM_BASE_URL` | In-cluster or sidecar LiteLLM |
| `REDIS_URL` | Required for multi-replica rate limits |
| `METRICS_AUTH_TOKEN` | Required when `METRICS_ENABLED=true` |
| `TRUST_PROXY` | Required when `MODELGOV_BEHIND_PROXY=true` |

Run offline checks before deploy:

```bash
pnpm modelgov doctor production --env-file .env.production
```

See [production boot check failures](./security-production-boot-checks.md) for every error and fix.

---

## Secrets model

- Mount secrets via `*_FILE` env vars (Docker/K8s/Vault CSI).
- Seed **one** bootstrap key with `keys:admin`, then issue all other keys via `/v1/admin/keys`.
- Never commit `.env.production` or real keys to git.
- Rotate provider keys in LiteLLM independently of Modelgov API keys.

---

## Image pinning

Production refuses floating tags when `production: true` (Helm) or `MODELGOV_PRODUCTION=true` (compose).

Pin every image to a **version tag or `@sha256:` digest**:

```yaml
image:
  tag: v1.1.0   # or sha256:...
```

Verify artifacts after release:

```bash
scripts/verify-release-artifacts.sh v1.1.0 your-org/Modelgov
```

### Image architecture

The published `modelgov-api` image is **`linux/amd64` only**. On `arm64` hosts
(AWS Graviton, Apple Silicon, Ampere) a plain `docker pull` either fails with
`exec format error` or silently runs under QEMU emulation with multi-second
per-request latency. On arm64, **build the image natively** instead of pulling:

```bash
# on the arm64 host / build machine
BUILD_LOCAL_IMAGE=true MODELGOV_API_IMAGE=modelgov-api:local make up-prod
# or explicitly:
docker build -t modelgov-api:local -f packages/api/Dockerfile .
```

(A native multi-arch image is planned; until then amd64 is the only published arch.)

---

## Postgres requirements

- Postgres **16+**
- Connection pooling: set `DB_POOL_MAX` per replica (default 10)
- Enable automated backups (managed service or `scripts/backup-postgres.sh`)
- Run migrations before or during rollout (API runs `migrate.js` on boot)

---

## Redis requirements

- Redis **7+** for shared rate limits across replicas
- Without Redis, rate limits are per-pod only (budget atomicity still uses Postgres)
- Set `RATE_LIMIT_FAIL_OPEN=false` in production

---

## TLS and load balancer

- Terminate TLS at ingress; Modelgov listens HTTP inside the cluster
- Set `MODELGOV_BEHIND_PROXY=true` and `TRUST_PROXY` to your LB CIDR
- Configure liveness (`/health`) and readiness (`/ready`) probes — see [operations.md](./operations.md)

---

## Migration flow

1. Backup Postgres (`scripts/backup-postgres.sh`)
2. Deploy new image tag (same minor version line)
3. API pods run `migrate.js` on startup (advisory lock prevents races)
4. Wait for `/ready` on all replicas
5. Run `scripts/prod-readiness-check.sh`

See [upgrades.md](./upgrades.md) for version-to-version paths.

---

## Readiness and liveness

| Probe | Path | Pass condition |
| --- | --- | --- |
| Liveness | `GET /health` | `{"status":"ok"}` — no DB |
| Readiness | `GET /ready` | `{"status":"ready"}` — DB + deps |

---

## Smoke test

```bash
export MODELGOV_URL=https://modelgov.example.com
export MODELGOV_API_KEY='your-key'
scripts/prod-readiness-check.sh
```

---

## Rollback

1. `helm rollback modelgov <revision>` (or redeploy previous image digest)
2. **Database:** downgrades are unsupported if migrations are not backward-compatible — restore from backup if needed ([backup-restore drill](./runbooks/backup-restore-drill.md))
3. Re-run readiness script

---

## HA note

Helm with `api.replicas >= 2`, managed Postgres, and managed Redis is the **reference HA path**. `make up-prod` is a **single-host, non-HA** shortcut — do not use it as an enterprise HA baseline.

See [high-availability.md](./deployment/high-availability.md) for the failure matrix.
