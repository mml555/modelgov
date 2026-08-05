#!/usr/bin/env bash
# Render the Helm chart under every shipped values profile.
#
# The chart is the RECOMMENDED production path but nothing in CI ever rendered
# it, so a profile could ship undeployable — and did: the production profiles set
# `production=true` + `api.metricsEnabled=true`, whose fail-closed validation
# demands secrets the documented install command did not pass. `helm lint` alone
# does NOT catch this (it renders with defaults, where the guards are inert);
# only templating each profile with realistic secrets does.
#
#   bash scripts/helm-render-check.sh
#
# Requires `helm`. Skips cleanly when helm is unavailable so it can be dropped
# into CI without making helm a hard dependency of every job.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="$ROOT/deploy/helm/modelgov"

if ! command -v helm >/dev/null 2>&1; then
  echo "helm-render-check: helm not installed — skipping"
  exit 0
fi

rand() { openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# Every secret the production profiles require. Deliberately explicit: if the
# chart grows another required secret, this list must grow with it, which is the
# reminder that the install docs need updating too.
COMMON=(
  --set image.repository=ghcr.io/example/modelgov-api
  --set image.tag=v0.0.0-test
  --set "secret.aiGuardApiKey=$(rand)"
  --set "secret.litellmMasterKey=$(rand)"
  --set "secret.metricsAuthToken=$(rand)"
  --set "secret.databaseUrl=postgres://user:pass@db:5432/modelgov"
)

fail=0
echo "==> helm lint"
helm lint "$CHART" >/dev/null 2>&1 || { echo "  FAIL: helm lint"; fail=1; }
[ "$fail" -eq 0 ] && echo "  ok"

for values in values.yaml values-selfhost.yaml values-multitenant.yaml values-azure.yaml; do
  printf '==> render %-24s ' "$values"
  if out=$(helm template modelgov "$CHART" -f "$CHART/$values" "${COMMON[@]}" 2>&1); then
    echo "ok ($(grep -c '^kind:' <<<"$out") resources)"
  else
    echo "FAIL"
    grep -E '^Error' <<<"$out" | head -2 | sed 's/^/     /'
    fail=1
  fi
done

# The selfhost + azure overlay is a documented combination, so it must also render.
printf '==> render %-24s ' "selfhost+azure"
if out=$(helm template modelgov "$CHART" -f "$CHART/values-selfhost.yaml" -f "$CHART/values-azure.yaml" "${COMMON[@]}" 2>&1); then
  echo "ok ($(grep -c '^kind:' <<<"$out") resources)"
else
  echo "FAIL"; grep -E '^Error' <<<"$out" | head -2 | sed 's/^/     /'; fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "helm-render-check: FAILED" >&2
  exit 1
fi
echo "helm-render-check: ok"
