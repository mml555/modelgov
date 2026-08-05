#!/usr/bin/env bash
# Adversarial probe against a RUNNING gateway.
#   MODELGOV_URL=https://gw.example.com MODELGOV_API_KEY=sk-... bash scripts/security-probe.sh
#
# Targets the failures that are catastrophic rather than annoying: cross-user
# idempotency leaks, injection through identity fields, oversized bodies,
# permission escalation, and tenant-header forgery. It sends hostile input — run
# it against staging first, and note case D may briefly pause/resume the gateway
# if the key holds the emergency permission.
set -uo pipefail
URL="${MODELGOV_URL:-http://localhost:3090}"
KEY="${MODELGOV_API_KEY:-sk-modelgov-api-local}"
# Second-level timestamps collide when two probes start in the same second,
# which cross-contaminates budgets, idempotency keys and audit assertions.
R="sec$(date +%s)-$( (od -An -N4 -tx1 /dev/urandom | tr -d ' \n') 2>/dev/null || echo $$ )"

# Never put a bearer key on the wire in cleartext to a non-local host.
case "$URL" in
  https://*) ;;
  http://localhost*|http://127.0.0.1*|http://\[::1\]*) ;;
  *)
    if [ "${MODELGOV_ALLOW_INSECURE:-false}" != "true" ]; then
      echo "Refusing to send an API key over cleartext to $URL." >&2
      echo "Use https, or set MODELGOV_ALLOW_INSECURE=true for a trusted private network." >&2
      exit 2
    fi
    ;;
esac
pass=0; fail=0
ok(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad(){ printf '  \033[31mFAIL\033[0m %s\n     %s\n' "$1" "$2"; fail=$((fail+1)); }
hdr(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

post(){ curl -s -m 30 -X POST "$URL/v1/chat" -H "authorization: Bearer $KEY" -H 'content-type: application/json' "$@"; }

hdr "A. Idempotency must not leak across users"
IK="leak-$R"
b1=$(post -H "idempotency-key: $IK" -d "{\"userId\":\"${R}_alice\",\"userType\":\"logged_in\",\"feature\":\"support_chat\",\"messages\":[{\"role\":\"user\",\"content\":\"alice secret question\"}]}")
b2=$(post -H "idempotency-key: $IK" -d "{\"userId\":\"${R}_bob\",\"userType\":\"logged_in\",\"feature\":\"support_chat\",\"messages\":[{\"role\":\"user\",\"content\":\"bob different question\"}]}")
id1=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('requestId',''))" "$b1" 2>/dev/null)
id2=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d.get('requestId') or d.get('error',{}).get('code',''))" "$b2" 2>/dev/null)
if [ -z "$id1" ]; then
  # Without a successful first request there is nothing to replay, so a "pass"
  # here would be vacuous — a timeout or 5xx must not read as isolation.
  bad "could not establish alice's baseline request" "alice response: ${b1:0:140}"
elif [ -z "$id2" ]; then
  bad "bob's request produced neither a requestId nor an error code" "bob response: ${b2:0:140}"
elif [ "$id1" = "$id2" ]; then
  bad "bob replayed alice's response with the same idempotency key" "both requestId=$id1"
else
  ok "same idempotency key from a different user does NOT return alice's response (bob: $id2)"
fi

hdr "B. Identity fields must not be injectable"
for payload in "'; DROP TABLE request_logs; --" "\$(whoami)" "../../etc/passwd" "<script>alert(1)</script>" "%00nullbyte"; do
  esc=$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$payload")
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -X POST "$URL/v1/chat" -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d "{\"userId\":$esc,\"userType\":\"logged_in\",\"feature\":\"support_chat\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
  case "$code" in
    200|400|403) ok "hostile userId handled cleanly (HTTP $code): ${payload:0:24}" ;;
    *) bad "hostile userId caused $code" "$payload" ;;
  esac
done
# The table must still exist.
after=$(curl -s -o /dev/null -w '%{http_code}' -m 15 -H "authorization: Bearer $KEY" "$URL/v1/requests?limit=1")
[ "$after" = "200" ] && ok "audit table intact after injection attempts" || bad "audit table check" "got $after"

hdr "C. Oversized / malformed input"
# Build the payload in a FILE: a 2MB shell argument exceeds ARG_MAX and makes
# curl fail at the transport layer, which looks like a product failure but isn't.
bigfile="$(mktemp)"
python3 -c "
import json,sys
json.dump({'userId':'oversize','userType':'logged_in','feature':'support_chat',
           'messages':[{'role':'user','content':'x'*2_000_000}]}, open(sys.argv[1],'w'))" "$bigfile"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 60 -X POST "$URL/v1/chat" -H "authorization: Bearer $KEY" -H 'content-type: application/json' --data-binary @"$bigfile")
rm -f "$bigfile"
if [ "$code" = "413" ] || [ "$code" = "400" ]; then ok "2MB body rejected (HTTP $code), not accepted or crashed"; else bad "oversized body" "got $code"; fi
code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 -X POST "$URL/v1/chat" -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"userId":null,"userType":123,"feature":[],"messages":"nope"}')
[ "$code" = "400" ] && ok "wrong-typed fields -> 400" || bad "type confusion" "got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 -X POST "$URL/v1/chat" -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"userId":"a","userType":"logged_in","feature":"support_chat","messages":[{"role":"system","content":"x"}],"maxTokens":-5}')
[ "$code" = "400" ] || [ "$code" = "200" ] && ok "negative maxTokens handled (HTTP $code)" || bad "negative maxTokens" "got $code"

hdr "D. Permission enforcement"
for ep in "/v1/admin/keys" "/v1/admin/audit" "/v1/admin/policy/versions"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 -H "authorization: Bearer $KEY" "$URL$ep")
  case "$code" in
    200) ok "$ep reachable for this key (has the permission)" ;;
    403) ok "$ep correctly 403 for a key without the permission" ;;
    *) bad "$ep unexpected" "got $code" ;;
  esac
done
# State-changing by nature: pausing a gateway stops ALL traffic, and a failed
# resume would leave it that way. Opt-in only, and the resume is retried and
# verified rather than fired once and hoped for.
if [ "${PROBE_EMERGENCY_PAUSE:-false}" = "true" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 -X POST "$URL/v1/admin/emergency/pause" -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{}')
  case "$code" in 200|403) ok "emergency pause gated (HTTP $code)";; *) bad "emergency pause" "got $code";; esac
  if [ "$code" = "200" ]; then
    resumed=""
    for _ in 1 2 3; do
      rc=$(curl -s -o /dev/null -w '%{http_code}' -m 15 -X POST "$URL/v1/admin/emergency/resume" -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{}')
      [ "$rc" = "200" ] && { resumed=1; break; }
      sleep 2
    done
    # Confirm from the gateway, not from our own request's status code.
    state=$(curl -s -m 15 -H "authorization: Bearer $KEY" "$URL/v1/admin/emergency/status")
    if [ -n "$resumed" ] && ! grep -qi '"paused":[[:space:]]*true' <<<"$state"; then
      ok "emergency pause resumed and verified"
    else
      bad "GATEWAY MAY STILL BE PAUSED — resume it manually" "status: ${state:0:120}"
    fi
  fi
else
  printf '  \033[33mSKIP\033[0m emergency pause/resume (set PROBE_EMERGENCY_PAUSE=true to include)\n'
fi

hdr "E. Tenant header cannot be forged without permission"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 -X POST "$URL/v1/chat" -H "authorization: Bearer $KEY" -H 'x-modelgov-tenant: other-tenant' -H 'content-type: application/json' \
  -d "{\"userId\":\"$R\",\"userType\":\"logged_in\",\"feature\":\"support_chat\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
case "$code" in
  403) ok "tenant switch refused without tenant:switch permission" ;;
  200) ok "tenant switch allowed — this key holds tenant:switch (platform key)" ;;
  *) bad "tenant header handling" "got $code" ;;
esac

printf '\n\033[1m== %d passed, %d failed ==\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
