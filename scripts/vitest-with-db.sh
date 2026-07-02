#!/usr/bin/env bash
# Run Vitest with integration tests enabled. Uses DATABASE_URL when set (CI);
# otherwise starts a disposable Postgres container via test-with-db.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -n "${DATABASE_URL:-}" ]; then
  cd "$ROOT"
  exec pnpm exec vitest run "$@"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "error: DATABASE_URL is not set and docker is not available." >&2
  echo "" >&2
  echo "Integration tests require Postgres. Either:" >&2
  echo "  export DATABASE_URL=postgres://user:pass@localhost:5432/aiguard" >&2
  echo "  make test-db                    # disposable Postgres + full suite" >&2
  echo "  pnpm test:db -- --coverage      # same, with coverage" >&2
  exit 1
fi

exec bash "$ROOT/scripts/test-with-db.sh" "$@"
