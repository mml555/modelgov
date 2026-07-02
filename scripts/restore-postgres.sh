#!/usr/bin/env bash
# Restore Ai-Guard Postgres from a pg_dump backup.
# Usage: DATABASE_URL=... scripts/restore-postgres.sh backups/ai-guard-*.sql.gz
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP="${1:?usage: restore-postgres.sh <backup.sql.gz>}"

if [ ! -f "$BACKUP" ]; then
  echo "backup file not found: $BACKUP" >&2
  exit 1
fi

echo "Restoring Ai-Guard Postgres from $BACKUP"
echo "WARNING: this drops and recreates objects in the target database."
read -r -p "Continue? [y/N] " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
  echo "Aborted."
  exit 1
fi

gunzip -c "$BACKUP" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1

echo "restore-postgres: ok — run scripts/verify-restore.sh to smoke-test"
