# Backup and restore drill

Tested procedure for Postgres backup, restore, and verification.

## Tables that matter most

| Table | Why |
| --- | --- |
| `request_logs` | Audit trail / operator request history |
| `api_keys` | DB-backed key store (hashes only) |
| `budget_counters` | Budget state |
| `schema_migrations` | Applied migration versions |
| `config_versions` | Policy store (when enabled) |
| `admin_audit_log` | Tamper-evident operator actions |

## Backup

From a running deployment with `DATABASE_URL` set:

```bash
export DATABASE_URL='postgres://user:pass@host:5432/modelgov'
scripts/backup-postgres.sh ./backups
```

Output: `backups/modelgov-<timestamp>.sql.gz` (+ optional `.sha256`).

**RPO:** Depends on backup schedule — aim for ≤15 min with managed Postgres PITR or hourly logical dumps.

## Restore

**Warning:** Overwrites objects in the target database.

```bash
export DATABASE_URL='postgres://user:pass@fresh-host:5432/modelgov'
scripts/restore-postgres.sh ./backups/modelgov-20260701T120000Z.sql.gz
```

## Smoke test after restore

```bash
export DATABASE_URL='postgres://...'
export MODELGOV_API_KEY='your-key'
scripts/verify-restore.sh
```

Expected: `/ready` returns `ready`, critical tables present.

Then run the full readiness drill:

```bash
export MODELGOV_URL=http://127.0.0.1:3098  # verify-restore default port
scripts/prod-readiness-check.sh
```

## RTO / RPO language

| Metric | Target (operator-managed) |
| --- | --- |
| **RPO** | ≤15 min with continuous archiving or frequent logical backups |
| **RTO** | ≤60 min to restore DB + redeploy API replicas (depends on backup size and infra) |

Modelgov software does not perform backups — your Postgres operator or `pg_dump` schedule does.

## Drill checklist

- [ ] Take logical backup from production-like environment
- [ ] Restore to a **fresh** empty database
- [ ] `verify-restore.sh` passes
- [ ] `prod-readiness-check.sh` passes
- [ ] Confirm `request_logs` row count matches expectations
- [ ] Confirm API keys still authenticate (hashes restored)

Run this drill quarterly and after major schema migrations.
