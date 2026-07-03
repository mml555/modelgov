# Production boot check failures

When `MODELGOV_PRODUCTION=true`, the API refuses to boot on unsafe configuration.
Use `pnpm modelgov doctor production` for an offline check before deploy.

| Error | Severity | Fix |
| --- | --- | --- |
| Known dev API key | fail | Replace `sk-modelgov-api-local` / `smoke-test-key` with a random secret |
| Weak API key (<24 chars) | fail | Generate `openssl rand -hex 32` |
| Static admin key without bootstrap flag | fail | Set `ALLOW_BOOTSTRAP_ADMIN_KEY=true` once, then migrate to DB keys |
| `METRICS_ENABLED` without auth | fail | Set `METRICS_AUTH_TOKEN` or `METRICS_ALLOW_PUBLIC=true` (discouraged) |
| `OBSERVABILITY_CAPTURE_CONTENT=true` | fail | Set `false` or `OBSERVABILITY_CAPTURE_CONTENT_ALLOW=true` |
| `IDEMPOTENCY_CAPTURE_CONTENT=true` | fail | Set `false` or `IDEMPOTENCY_CAPTURE_CONTENT_ALLOW=true` |
| `DATABASE_SSL=disable` | fail | Use `require`/`verify-full`, or `DATABASE_SSL_DISABLE_ALLOWED=true` for bundled Postgres only |
| `DATABASE_SSL=disable` on remote host | fail | Always use TLS for managed Postgres |
| `MODELGOV_BEHIND_PROXY=true` without `TRUST_PROXY` | fail | Set `TRUST_PROXY` to LB CIDR or hop count |
| Langfuse dev credentials | fail | Replace keys or set `OBSERVABILITY_PROVIDER=none` |
| Weak `METRICS_AUTH_TOKEN` | fail | Use ≥24 random characters |
| OIDC without `OIDC_AUDIENCE` | fail | Set `OIDC_AUDIENCE` to your client ID |

Implementation: [`packages/api/src/config/productionGuards.ts`](../packages/api/src/config/productionGuards.ts)

CI validates a **filled** production example via [`scripts/doctor-production-example.ts`](../scripts/doctor-production-example.ts).
