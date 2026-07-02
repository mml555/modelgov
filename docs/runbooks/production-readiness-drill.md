# Production readiness drill

Repeatable drill to prove a deployed Ai-Guard instance is healthy after install, upgrade, or incident recovery.

## Prerequisites

- Running Ai-Guard API reachable at `AI_GUARD_URL`
- Valid API key with at least `chat:create` (and `keys:admin` for full drill)
- `curl`, `node`, and `npx wait-on` available locally
- For metrics checks: `METRICS_ENABLED=true` and `METRICS_AUTH_TOKEN` set on the target

## Commands

### Full drill (deployed environment)

```bash
export AI_GUARD_URL=https://ai-guard.example.com
export AI_GUARD_API_KEY='your-production-key'
export METRICS_ENABLED=true
export METRICS_AUTH_TOKEN='your-metrics-token'

scripts/prod-readiness-check.sh
```

### Light drill (CI / compose)

Skips key rotation admin tests:

```bash
export AI_GUARD_URL=http://127.0.0.1:3000
export AI_GUARD_API_KEY=sk-ai-guard-api-local
export PROD_READINESS_LIGHT=true

scripts/prod-readiness-check.sh
```

## Expected output

```
Ai-Guard production readiness check
  target: https://ai-guard.example.com

  ✓ GET /health — status=ok
  ✓ GET /ready — status=ready
  ✓ POST /v1/chat without auth — 401
  ...

════════════════════════════════════════
 Production readiness report
════════════════════════════════════════
  PASS: 10  FAIL: 0  WARN: 0

PASSED — production readiness checks complete
```

Exit code **0** = pass; **non-zero** = at least one FAIL.

## Failure handling

| Failure | Likely cause | Fix |
| --- | --- | --- |
| `/ready` not ready | Migrations pending, DB down, LiteLLM unreachable | Check pod logs, `DATABASE_URL`, dependency URLs |
| `/v1/explain` non-200 | Auth misconfiguration | Verify API key and permissions |
| `/metrics` unprotected | Missing `METRICS_AUTH_TOKEN` | Set token or `METRICS_ALLOW_PUBLIC=true` (discouraged) |
| Key admin skipped (WARN) | Key lacks `keys:admin` | Use bootstrap admin key or OIDC operator JWT |

## Rollback notes

If readiness fails after upgrade:

1. Roll back to previous Helm revision or image digest
2. If migrations ran, restore Postgres from pre-upgrade backup
3. Re-run this drill before declaring service restored

See [production-deploy.md](../production-deploy.md) and [backup-restore-drill.md](./backup-restore-drill.md).
