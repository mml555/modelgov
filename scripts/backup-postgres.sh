#!/usr/bin/env bash
# Create a logical backup of the Modelgov Postgres database.
# Usage: DATABASE_URL=... scripts/backup-postgres.sh [output_dir]
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

OUT_DIR="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${OUT_DIR}/modelgov-${STAMP}.sql.gz"

mkdir -p "$OUT_DIR"

echo "Backing up Modelgov Postgres to $FILE"
pg_dump "$DATABASE_URL" --no-owner --no-acl | gzip > "$FILE"

if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$FILE" | tee "${FILE}.sha256"
fi

echo "backup-postgres: ok ($FILE)"
