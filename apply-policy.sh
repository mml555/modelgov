#!/usr/bin/env bash
# Apply ./modelgov.yaml as a new ACTIVE policy version, then reload the API.
#
# Why this exists: the stack runs with POLICY_STORE_ENABLED=true, so the
# database — not the file — is the source of truth at runtime. The normal way to
# push a new version is the operator console, which currently cannot build (its
# Dockerfile runs policy-engine's `prepare` script before the sources are
# COPY'd). Until that is fixed, this does the same job.
#
# Non-destructive: previous versions are kept and simply deactivated, so the
# version history the config store exists to provide stays intact.
#
# Usage:  ./apply-policy.sh [note]
set -euo pipefail
cd "$(dirname "$0")"

NOTE="${1:-applied from modelgov.yaml}"
PG_CONTAINER="${PG_CONTAINER:-modelgov-postgres-1}"
API_CONTAINER="${API_CONTAINER:-modelgov-api-1}"
API_URL="${API_URL:-http://127.0.0.1:3090}"

command -v docker >/dev/null || { echo "apply-policy: docker not found" >&2; exit 1; }
docker inspect "$PG_CONTAINER" >/dev/null 2>&1 \
  || { echo "apply-policy: $PG_CONTAINER not running — start the stack first" >&2; exit 1; }

# Validate BEFORE writing. Activating a config the engine rejects would leave
# the API refusing to boot on its next restart.
echo "→ validating modelgov.yaml"
pnpm -s modelgov validate --config modelgov.yaml

echo "→ inserting + activating new version"
python3 - "$NOTE" <<'PY' > /tmp/modelgov-apply.sql
import hashlib, sys
note = sys.argv[1].replace("'", "''")
y = open("modelgov.yaml").read()
if "$yaml$" in y:
    sys.exit("modelgov.yaml contains the dollar-quote delimiter; cannot embed safely")
cs = hashlib.sha256(y.encode()).hexdigest()
print(f"""begin;
update config_versions set active=false where tenant_id='default' and active;
insert into config_versions
  (tenant_id, author, note, yaml_text, checksum, active, activated_at, status)
values
  ('default','apply-policy.sh','{note}', $yaml${y}$yaml$, '{cs}', true, now(), 'approved');
commit;""")
PY
docker exec -i "$PG_CONTAINER" psql -U postgres -d modelgov -q < /tmp/modelgov-apply.sql
rm -f /tmp/modelgov-apply.sql

echo "→ restarting API"
docker restart "$API_CONTAINER" >/dev/null

for _ in $(seq 1 30); do
  if curl -sf "$API_URL/ready" >/dev/null 2>&1; then
    docker logs "$API_CONTAINER" 2>&1 | grep -E "loaded active policy version" | tail -1
    echo "✓ active"
    exit 0
  fi
  sleep 1
done

echo "apply-policy: API did not become ready in 30s — check: docker logs $API_CONTAINER" >&2
exit 1
