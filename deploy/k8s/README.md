# Kubernetes deployment (sketch)

> **Prefer the [Helm chart](../helm/ai-guard/README.md)** for a real install —
> it templates the API (with a pre-upgrade migration hook), LiteLLM, Redis, and
> optional Presidio/Postgres/Ingress from values, and is validated with
> `helm lint` + `kubectl` client checks. These raw manifests are a minimal
> reference for adapting by hand.

Minimal manifests to run Ai-Guard on Kubernetes. Adapt namespaces, secrets, and image references for your cluster.

## Prerequisites

- Postgres (managed RDS/Cloud SQL, or the bundled StatefulSet below)
- Redis for multi-replica rate limiting
- LiteLLM + Presidio (deploy separately or extend this chart)
- Built API image pushed to your registry

## Files

| File | Purpose |
| --- | --- |
| `namespace.yaml` | Isolated namespace |
| `secret.example.yaml` | Template for API keys and `DATABASE_URL` |
| `configmap.yaml` | Mount `ai-guard.yaml` policy |
| `migration-job.yaml` | One-shot schema apply (`node dist/migrate.js`) |
| `deployment.yaml` | API Deployment with probes |
| `service.yaml` | ClusterIP Service on port 3000 |

## Deploy order

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/secret.example.yaml   # edit first — never commit real secrets
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/migration-job.yaml
kubectl wait --for=condition=complete job/ai-guard-migrate -n ai-guard --timeout=120s
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/service.yaml
```

## Health probes

- **Liveness:** `GET /health` — in-process only; DB blips must not restart pods.
- **Readiness:** `GET /ready` — gates traffic on Postgres.

## Production notes

- Terminate TLS at an Ingress / Gateway; set `TRUST_PROXY` to your ingress CIDRs.
- Set `METRICS_AUTH_TOKEN` and scrape `/metrics` from an internal Prometheus.
- Pin images by digest, not floating tags.
- Run Postgres and Redis as managed services in production rather than in-cluster defaults.

See [Operations guide](../../docs/operations.md) for the full checklist.
