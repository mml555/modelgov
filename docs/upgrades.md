# Upgrades

Guidance for upgrading Ai-Guard between release versions.

## Supported upgrade paths

| From | To | Supported |
| --- | --- | --- |
| Previous patch (e.g. `0.0.0` → `0.0.1`) | Current release | Yes — forward migrations only |
| Same minor, skipped patches | Current | Yes if migrations are cumulative |
| **Downgrade** (newer → older image) | | **Unsupported** if migrations ran — restore from backup |

Always read [CHANGELOG.md](../CHANGELOG.md) and [RELEASE_NOTES/](../RELEASE_NOTES/) for breaking changes.

## Pre-upgrade checklist

1. **Backup Postgres** — `scripts/backup-postgres.sh`
2. **Verify version alignment** — `bash scripts/verify-versions.sh`
3. **Run production doctor** — `pnpm ai-guard doctor production`
4. **Note current image digest** for rollback

## Upgrade procedure (Helm)

```bash
# 1. Backup
export DATABASE_URL='postgres://...'
scripts/backup-postgres.sh ./backups

# 2. Upgrade chart + image
helm upgrade ai-guard deploy/helm/ai-guard \
  --namespace ai-guard \
  --set image.tag=v0.0.0 \
  -f your-values.yaml

# 3. Wait for rollout
kubectl rollout status deployment/ai-guard-api -n ai-guard

# 4. Readiness drill
export AI_GUARD_URL=https://ai-guard.example.com
export AI_GUARD_API_KEY='...'
scripts/prod-readiness-check.sh
```

## Migration command

Migrations run automatically on API boot via `migrate.js` (advisory lock prevents duplicate application across replicas). To migrate manually:

```bash
node packages/api/dist/migrate.js
```

## Rollback behavior

| Scenario | Action |
| --- | --- |
| New pods fail readiness | `helm rollback ai-guard <revision>` |
| Migration succeeded but app broken | Roll back image **and** restore DB if schema incompatible |
| Config-only change | Revert `ai-guard.yaml` or activate prior policy version via `/v1/admin/policy` |

**Downgrades:** If a migration is not reversible, you must restore the pre-upgrade backup — do not run an older binary against a newer schema.

**Authoring migrations (large tables / zero-downtime):** Migrations run forward-only, one per file, each in its own transaction under an advisory lock, and the migrate process runs with statement/query timeouts disabled so a long index build or a blocking lock wait is never killed mid-run. Because each migration is transactional, `CREATE INDEX CONCURRENTLY` (which cannot run in a transaction) is not used — on a large, live table build the index out-of-band first, or accept the lock during a maintenance window. For a column/PK change on a hot table, follow expand→migrate→contract: add the new shape in one release, backfill and switch reads/writes, drop the old shape in a later release, so an old pod and a new pod can serve simultaneously during a rolling deploy.

## Config compatibility

- `ai-guard.yaml` is validated strictly: an unknown or misspelled key (e.g. `montly_usd`) is a hard error, not silently ignored — a mistyped cap can never fail open. Validate before deploy with `pnpm ai-guard validate --production`
- New env vars are optional with safe defaults — see [configuration.md](./configuration.md)
- Enable new features (`POLICY_STORE_ENABLED`, `MULTI_TENANT_POLICY`) only after reading design docs

## CI migration matrix

CI runs `packages/api/test/migration-upgrade.test.ts` against Postgres to verify:

- Fresh install applies all migrations
- Re-applying the latest migration is safe (idempotent guards)

## Per-release notes

Each GitHub release includes:

- Docker image `vX.Y.Z`
- npm / PyPI packages at `X.Y.Z`
- `openapi-vX.Y.Z.json` asset
- Migration notes in CHANGELOG

Verify artifacts: `scripts/verify-release-artifacts.sh vX.Y.Z`
