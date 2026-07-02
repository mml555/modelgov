#!/usr/bin/env bash
# Boot the API against CI Postgres and smoke-test /health, /ready, POST /v1/chat.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${DATABASE_URL:?DATABASE_URL is required}"

pnpm build >/dev/null

# Migrate before boot — mirrors the production image (migrate.js && index.js) and
# proves cold-start on an empty DB. CI must not rely on integration tests having
# already applied the schema to the shared Postgres service.
node packages/api/dist/migrate.js

export PORT="${SMOKE_PORT:-3099}"
export HOST="127.0.0.1"
export AI_GUARD_API_KEY="${SMOKE_API_KEY:-smoke-test-key}"
export AI_GUARD_CONFIG="${ROOT}/scripts/smoke-ai-guard.yaml"
export LITELLM_BASE_URL="${SMOKE_LITELLM_URL:-http://127.0.0.1:1}"
export OBSERVABILITY_PROVIDER=none
export METRICS_ENABLED=false
export MAINTENANCE_ENABLED=false
export RATE_LIMIT_MAX=1000

# Start API in background; LiteLLM is unreachable — smoke only checks boot + auth + policy block path.
node packages/api/dist/index.js &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT

npx wait-on "http://127.0.0.1:${PORT}/health" --timeout 30000

curl -sf "http://127.0.0.1:${PORT}/health" | grep -q '"status":"ok"'
curl -sf "http://127.0.0.1:${PORT}/ready" | grep -q '"status"'

# Missing auth → 401
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/v1/chat" \
  -H 'content-type: application/json' \
  -d '{"userId":"u","userType":"logged_in","feature":"support_chat","messages":[{"role":"user","content":"hi"}]}')
test "$code" = "401"

# Authed request reaches the handler (502 provider_unavailable is expected without LiteLLM).
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/v1/chat" \
  -H "authorization: Bearer ${AI_GUARD_API_KEY}" \
  -H 'content-type: application/json' \
  -d '{"userId":"u","userType":"logged_in","feature":"support_chat","messages":[{"role":"user","content":"hi"}]}')
if [ "$code" != "502" ] && [ "$code" != "403" ] && [ "$code" != "200" ]; then
  echo "smoke-ci: unexpected /v1/chat status $code" >&2
  exit 1
fi

echo "smoke-ci: ok"
