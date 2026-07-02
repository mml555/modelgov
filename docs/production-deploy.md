# Production deployment guide

> **Official production path:** Helm + managed Postgres + managed Redis + external TLS + pinned images.
>
> Docker Compose (`make up-prod`) is for small self-hosted / non-HA deployments.
> Local compose modes are for development and evaluation only.

This guide walks from empty infrastructure to a running production Ai-Guard deployment using the **recommended Helm path**.

---

## Deployment modes

| Mode | Command | Intended use |
| --- | --- | --- |
| `make up` | `pnpm ai-guard up simple` | Local / dev |
| `make up-full` | `pnpm ai-guard up full` | Local / dev with Langfuse |
| `make up-local` | `pnpm ai-guard up local` | Local Ollama evaluation |
| `make up-prod` | `pnpm ai-guard up prod` | Small self-hosted production (**not HA**) |
| **Helm** | See below | **Recommended enterprise production** |

---

## Required infrastructure

| Component | Requirement |
| --- | --- |
| **Kubernetes** | 1.27+ with ingress controller |
| **Postgres** | 16+, managed (RDS, Cloud SQL, Azure Database), TLS enabled |
| **Redis** | 7+, managed, reachable from API pods |
| **TLS** | Terminated at ingress / load balancer (cert-manager or cloud LB) |
| **Container registry** | Pull `ghcr.io/<org>/ai-guard-api:v0.0.0` (pin digest in values) |
| **Secrets store** | K8s Secrets, Vault, or cloud secret manager for API keys and DB URL |

### Network diagram

```text
                    ┌─────────────────────────────────────┐
  Internet / VPC    │  TLS ingress (443)                  │
        │           │         │                           │
        ▼           │    ┌────▼─────┐   ┌──────────────┐  │
   Your apps ───────┼───▶│ Ai-Guard │──▶│ LiteLLM      │──┼──▶ OpenAI / Anthropic
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
helm upgrade --install ai-guard deploy/helm/ai-guard \
  --namespace ai-guard --create-namespace \
  --set production=true \
  --set image.repository=ghcr.io/your-org/ai-guard-api \
  --set image.tag=v0.0.0 \
  --set api.replicas=2 \
  --set-string api.extraEnv[0].name=AI_GUARD_PRODUCTION \
  --set-string api.extraEnv[0].value=true \
  --set-string api.extraEnv[1].name=DATABASE_URL \
  --set-string api.extraEnv[1].value='postgres://...' \
  --set-string api.extraEnv[2].name=AI_GUARD_API_KEY \
  --set-string api.extraEnv[2].value='from-secret' \
  --set redis.enabled=false \
  --set externalRedis.url='rediss://...' \
  --set postgres.enabled=false \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=ai-guard.example.com
```

Copy [`deploy/helm/ai-guard/values.yaml`](../deploy/helm/ai-guard/values.yaml) into a private values file for your org; never commit secrets.

---

## Required environment variables

See [`.env.production.example`](../.env.production.example) for the full list. Minimum for production:

| Variable | Notes |
| --- | --- |
| `AI_GUARD_PRODUCTION` | Must be `true` — enables fail-closed boot checks |
| `DATABASE_URL` | Managed Postgres connection string |
| `DATABASE_SSL` | `require` or `verify-full` (never `disable` for remote DB) |
| `AI_GUARD_API_KEY` or `AI_GUARD_API_KEYS` | Strong random secret; bootstrap admin key only with `ALLOW_BOOTSTRAP_ADMIN_KEY=true` |
| `AI_GUARD_CONFIG` | Path to production `ai-guard.yaml` (or enable policy store) |
| `LITELLM_BASE_URL` | In-cluster or sidecar LiteLLM |
| `REDIS_URL` | Required for multi-replica rate limits |
| `METRICS_AUTH_TOKEN` | Required when `METRICS_ENABLED=true` |
| `TRUST_PROXY` | Required when `AI_GUARD_BEHIND_PROXY=true` |

Run offline checks before deploy:

```bash
pnpm ai-guard doctor production --env-file .env.production
```

See [production boot check failures](./security-production-boot-checks.md) for every error and fix.

---

## Secrets model

- Mount secrets via `*_FILE` env vars (Docker/K8s/Vault CSI).
- Seed **one** bootstrap key with `keys:admin`, then issue all other keys via `/v1/admin/keys`.
- Never commit `.env.production` or real keys to git.
- Rotate provider keys in LiteLLM independently of Ai-Guard API keys.

---

## Image pinning

Production refuses floating tags when `production: true` (Helm) or `AI_GUARD_PRODUCTION=true` (compose).

Pin every image to a **version tag or `@sha256:` digest**:

```yaml
image:
  tag: v0.0.0   # or sha256:...
```

Verify artifacts after release:

```bash
scripts/verify-release-artifacts.sh v0.0.0 your-org/Ai-Guard
```

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

- Terminate TLS at ingress; Ai-Guard listens HTTP inside the cluster
- Set `AI_GUARD_BEHIND_PROXY=true` and `TRUST_PROXY` to your LB CIDR
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
export AI_GUARD_URL=https://ai-guard.example.com
export AI_GUARD_API_KEY='your-key'
scripts/prod-readiness-check.sh
```

---

## Rollback

1. `helm rollback ai-guard <revision>` (or redeploy previous image digest)
2. **Database:** downgrades are unsupported if migrations are not backward-compatible — restore from backup if needed ([backup-restore drill](./runbooks/backup-restore-drill.md))
3. Re-run readiness script

---

## HA note

Helm with `api.replicas >= 2`, managed Postgres, and managed Redis is the **reference HA path**. `make up-prod` is a **single-host, non-HA** shortcut — do not use it as an enterprise HA baseline.

See [high-availability.md](./deployment/high-availability.md) for the failure matrix.
