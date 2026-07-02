#!/usr/bin/env bash
# Optional CI e2e: boot postgres + api via docker-compose and smoke-test the stack.
# No provider keys required — dev safety preset, unreachable LiteLLM is expected.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE=(docker compose -f docker-compose.ci-e2e.yml)
PORT=3098
API_KEY=ci-e2e-key

cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

echo "example-e2e-ci: building and starting stack..."
"${COMPOSE[@]}" up --build -d

npx wait-on "http://127.0.0.1:${PORT}/ready" --timeout 120000

curl -sf "http://127.0.0.1:${PORT}/health" | grep -q '"status":"ok"'
curl -sf "http://127.0.0.1:${PORT}/ready" | grep -q '"status"'

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/v1/chat" \
  -H 'content-type: application/json' \
  -d '{"userId":"u","userType":"logged_in","feature":"support_chat","messages":[{"role":"user","content":"hi"}]}')
test "$code" = "401"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/v1/chat" \
  -H "authorization: Bearer ${API_KEY}" \
  -H 'content-type: application/json' \
  -d '{"userId":"u","userType":"logged_in","feature":"support_chat","messages":[{"role":"user","content":"hi"}]}')
if [ "$code" != "502" ] && [ "$code" != "403" ] && [ "$code" != "200" ]; then
  echo "example-e2e-ci: unexpected /v1/chat status $code" >&2
  exit 1
fi

echo "example-e2e-ci: ok"
