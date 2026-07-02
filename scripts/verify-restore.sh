#!/usr/bin/env bash
# Smoke-test a restored Ai-Guard database by booting the API and checking /ready.
# Usage: DATABASE_URL=... AI_GUARD_API_KEY=... scripts/verify-restore.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${AI_GUARD_API_KEY:?AI_GUARD_API_KEY is required}"

pnpm build >/dev/null 2>&1 || pnpm build

export PORT="${VERIFY_RESTORE_PORT:-3098}"
export HOST="127.0.0.1"
export AI_GUARD_CONFIG="${AI_GUARD_CONFIG:-${ROOT}/scripts/smoke-ai-guard.yaml}"
export LITELLM_BASE_URL="${LITELLM_BASE_URL:-http://127.0.0.1:1}"
export OBSERVABILITY_PROVIDER=none
export METRICS_ENABLED=false
export AI_GUARD_PRODUCTION=false

node packages/api/dist/index.js &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT

npx wait-on "http://127.0.0.1:${PORT}/ready" --timeout 60000

curl -sf "http://127.0.0.1:${PORT}/ready" | grep -q '"status":"ready"'

# Tables that must survive restore
node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  for (const table of ['request_logs', 'api_keys', 'usage_counters', 'schema_migrations']) {
    const r = await c.query(\`SELECT to_regclass('public.' || \$1) AS reg\`, [table]);
    if (!r.rows[0]?.reg) throw new Error('missing table: ' + table);
  }
  await c.end();
  console.log('ok critical tables present');
})().catch(e => { console.error(e); process.exit(1); });
"

echo "verify-restore: ok"
