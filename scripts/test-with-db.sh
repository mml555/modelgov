#!/usr/bin/env bash
# Run the full Vitest suite against a disposable Postgres 16 container.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER_NAME="${AIGUARD_TEST_PG_CONTAINER:-modelgov-test-pg}"
PG_PORT="${AIGUARD_TEST_PG_PORT:-55433}"
DATABASE_URL="postgres://postgres:postgres@localhost:${PG_PORT}/modelgov"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}

if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "Reusing existing container $CONTAINER_NAME on port $PG_PORT"
else
  trap cleanup EXIT
  echo "Starting Postgres test container on port $PG_PORT..."
  docker run -d --rm --name "$CONTAINER_NAME" \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=modelgov \
    -p "${PG_PORT}:5432" \
    postgres:16-alpine >/dev/null
fi

cd "$ROOT"
npx wait-on "tcp:localhost:${PG_PORT}" --timeout 60000
export DATABASE_URL
pnpm test "$@"
