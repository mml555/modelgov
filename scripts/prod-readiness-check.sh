#!/usr/bin/env bash
# Production readiness drill against a running Ai-Guard deployment.
# Configure via env vars (see docs/runbooks/production-readiness-drill.md).
set -euo pipefail

BASE_URL="${AI_GUARD_URL:-http://127.0.0.1:3000}"
API_KEY="${AI_GUARD_API_KEY:?AI_GUARD_API_KEY is required}"
INVALID_KEY="${AI_GUARD_INVALID_KEY:-invalid-key-on-purpose}"
METRICS_TOKEN="${METRICS_AUTH_TOKEN:-}"
METRICS_ENABLED="${METRICS_ENABLED:-false}"
LIGHT="${PROD_READINESS_LIGHT:-false}"

PASS=0
FAIL=0
WARN=0
REPORT=()

record() {
  local status="$1" name="$2" detail="${3:-}"
  REPORT+=("$status|$name|$detail")
  case "$status" in
    PASS) PASS=$((PASS + 1)); echo "  ✓ $name${detail:+ — $detail}" ;;
    FAIL) FAIL=$((FAIL + 1)); echo "  ✗ $name${detail:+ — $detail}" >&2 ;;
    WARN) WARN=$((WARN + 1)); echo "  ! $name${detail:+ — $detail}" ;;
  esac
}

http_code() {
  curl -s -o /dev/null -w '%{http_code}' "$@"
}

json_get() {
  curl -sf "$@" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j[$2]??'');}catch{process.exit(1)}})"
}

echo "Ai-Guard production readiness check"
echo "  target: $BASE_URL"
echo ""

# API boots + health
code=$(http_code "$BASE_URL/health")
if [ "$code" = "200" ]; then
  status=$(curl -sf "$BASE_URL/health" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).status" 2>/dev/null || echo "")
  if [ "$status" = "ok" ]; then
    record PASS "GET /health" "status=ok"
  else
    record FAIL "GET /health" "unexpected body status=$status"
  fi
else
  record FAIL "GET /health" "HTTP $code"
fi

code=$(http_code "$BASE_URL/ready")
if [ "$code" = "200" ]; then
  ready_status=$(curl -sf "$BASE_URL/ready" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).status" 2>/dev/null || echo "")
  if [ "$ready_status" = "ready" ]; then
    record PASS "GET /ready" "status=ready"
  else
    record FAIL "GET /ready" "status=$ready_status (migrations or deps not ready)"
  fi
else
  record FAIL "GET /ready" "HTTP $code"
fi

# Auth
code=$(http_code -X POST "$BASE_URL/v1/chat" \
  -H 'content-type: application/json' \
  -d '{"userId":"u","userType":"logged_in","feature":"support_chat","messages":[{"role":"user","content":"hi"}]}')
if [ "$code" = "401" ]; then
  record PASS "POST /v1/chat without auth" "401"
else
  record FAIL "POST /v1/chat without auth" "expected 401, got $code"
fi

code=$(http_code -X POST "$BASE_URL/v1/chat" \
  -H "authorization: Bearer $INVALID_KEY" \
  -H 'content-type: application/json' \
  -d '{"userId":"u","userType":"logged_in","feature":"support_chat","messages":[{"role":"user","content":"hi"}]}')
if [ "$code" = "401" ] || [ "$code" = "403" ]; then
  record PASS "POST /v1/chat invalid key" "$code"
else
  record FAIL "POST /v1/chat invalid key" "expected 401/403, got $code"
fi

# Explain (no provider)
explain_code=$(curl -s -o /tmp/explain.json -w '%{http_code}' -X POST "$BASE_URL/v1/explain" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"userId":"readiness","userType":"logged_in","feature":"support_chat","modelClass":"cheap"}' 2>/dev/null || echo "000")
if [ "$explain_code" = "200" ]; then
  record PASS "POST /v1/explain" "200"
else
  record FAIL "POST /v1/explain" "HTTP $explain_code"
fi

# Chat (provider may be unavailable — 200/403/502/503 acceptable)
chat_code=$(curl -s -o /tmp/chat.json -w '%{http_code}' -X POST "$BASE_URL/v1/chat" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"userId":"readiness","userType":"logged_in","feature":"support_chat","modelClass":"cheap","messages":[{"role":"user","content":"Say ok"}]}')
if [ "$chat_code" = "200" ] || [ "$chat_code" = "403" ] || [ "$chat_code" = "502" ] || [ "$chat_code" = "503" ]; then
  record PASS "POST /v1/chat authed" "HTTP $chat_code"
else
  record FAIL "POST /v1/chat authed" "unexpected HTTP $chat_code"
fi

# Usage logs readable
usage_code=$(http_code "$BASE_URL/v1/usage/summary?since=24h" -H "authorization: Bearer $API_KEY")
if [ "$usage_code" = "200" ] || [ "$usage_code" = "403" ]; then
  record PASS "GET /v1/usage/summary" "HTTP $usage_code"
else
  record FAIL "GET /v1/usage/summary" "HTTP $usage_code"
fi

requests_code=$(http_code "$BASE_URL/v1/requests?limit=5" -H "authorization: Bearer $API_KEY")
if [ "$requests_code" = "200" ] || [ "$requests_code" = "403" ]; then
  record PASS "GET /v1/requests" "HTTP $requests_code"
else
  record FAIL "GET /v1/requests" "HTTP $requests_code"
fi

# Metrics auth when enabled
if [ "$METRICS_ENABLED" = "true" ]; then
  m_unauth=$(http_code "$BASE_URL/metrics")
  if [ -n "$METRICS_TOKEN" ]; then
    if [ "$m_unauth" = "401" ] || [ "$m_unauth" = "403" ]; then
      record PASS "/metrics without token" "protected ($m_unauth)"
    else
      record FAIL "/metrics without token" "expected 401/403, got $m_unauth"
    fi
    m_auth=$(http_code "$BASE_URL/metrics" -H "Authorization: Bearer $METRICS_TOKEN")
    if [ "$m_auth" = "200" ]; then
      record PASS "/metrics with token" "200"
    else
      record FAIL "/metrics with token" "HTTP $m_auth"
    fi
  else
    record WARN "/metrics" "METRICS_ENABLED but no METRICS_AUTH_TOKEN to verify auth"
  fi
fi

if [ "$LIGHT" != "true" ] && [ "${API_KEYS_DB_ENABLED:-true}" = "true" ]; then
  # Key rotation smoke (requires keys:admin on API_KEY)
  key_resp=$(curl -sf -X POST "$BASE_URL/v1/admin/keys" \
    -H "authorization: Bearer $API_KEY" \
    -H 'content-type: application/json' \
    -d '{"name":"readiness-drill","permissions":["chat:create"],"expiresInDays":1}' 2>/dev/null || echo "")
  if echo "$key_resp" | grep -q '"id"'; then
    key_id=$(echo "$key_resp" | node -pe "JSON.parse(process.argv[1]).id" "$key_resp")
    rot_code=$(http_code -X POST "$BASE_URL/v1/admin/keys/${key_id}/revoke" -H "authorization: Bearer $API_KEY")
    if [ "$rot_code" = "200" ] || [ "$rot_code" = "204" ]; then
      record PASS "key create + revoke" "keys:admin"
    else
      record WARN "key revoke" "HTTP $rot_code (API_KEY may lack keys:admin)"
    fi
  else
    record WARN "key admin" "skipped — API_KEY lacks keys:admin or DB key store disabled"
  fi
fi

echo ""
echo "════════════════════════════════════════"
echo " Production readiness report"
echo "════════════════════════════════════════"
printf "  PASS: %s  FAIL: %s  WARN: %s\n" "$PASS" "$FAIL" "$WARN"
echo ""
for line in "${REPORT[@]}"; do
  IFS='|' read -r st name detail <<< "$line"
  printf "  [%s] %s%s\n" "$st" "$name" "${detail:+ — $detail}"
done
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "FAILED — $FAIL check(s) did not pass" >&2
  exit 1
fi

echo "PASSED — production readiness checks complete"
exit 0
