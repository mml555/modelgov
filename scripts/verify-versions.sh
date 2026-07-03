#!/usr/bin/env bash
# Fail if any publishable version surface drifts from the canonical root version.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
PY="$(grep -m1 '^version' packages/sdk-python/pyproject.toml | sed -E 's/.*"([^"]+)".*/\1/')"
PY_INIT="$(grep -m1 '__version__' packages/sdk-python/modelgov/__init__.py | sed -E 's/.*"([^"]+)".*/\1/')"
HELM_APP="$(grep -m1 '^appVersion' deploy/helm/modelgov/Chart.yaml | sed -E 's/.*"([^"]+)".*/\1/')"
HELM_CHART="$(grep -m1 '^version:' deploy/helm/modelgov/Chart.yaml | awk '{print $2}')"
OPENAPI_PLUGIN="$(grep -m1 'OPENAPI_VERSION' packages/api/src/plugins/openApi.ts | sed -E 's/.*"([^"]+)".*/\1/')"
OPENAPI_JSON="$(node -p "require('./packages/api/openapi.json').info.version")"
HELM_TAG="$(grep -m1 'tag:' deploy/helm/modelgov/values.yaml | sed -E 's/.*v([0-9.]+).*/\1/')"

fail=0
check() {
  local label="$1" actual="$2"
  if [ "$actual" != "$VERSION" ]; then
    echo "FAIL $label: expected $VERSION, got $actual" >&2
    fail=1
  else
    echo "ok   $label = $VERSION"
  fi
}

echo "Canonical version: $VERSION"
check "package.json" "$VERSION"
check "pyproject.toml" "$PY"
check "modelgov/__init__.py" "$PY_INIT"
check "Helm appVersion" "$HELM_APP"
check "Helm chart version" "$HELM_CHART"
check "OPENAPI_VERSION" "$OPENAPI_PLUGIN"
check "openapi.json info.version" "$OPENAPI_JSON"
check "Helm values image.tag (without v)" "$HELM_TAG"

for pkgdir in packages/policy-engine packages/sdk-typescript packages/cli packages/create-modelgov; do
  PV="$(node -p "require('./$pkgdir/package.json').version")"
  PN="$(node -p "require('./$pkgdir/package.json').name")"
  check "$PN" "$PV"
done

# Stale version references in docs/examples (exclude changelog/history paths).
STALE=$(grep -RIn --exclude-dir=node_modules --exclude-dir=dist \
  --exclude=CHANGELOG.md --exclude-dir=RELEASE_NOTES \
  -E 'v0\.5\.0|v0\.6\.0|\b0\.0\.x\b' docs README.md deploy SECURITY.md 2>/dev/null || true)
if [ -n "$STALE" ]; then
  echo "FAIL stale version references (use $VERSION or document in CHANGELOG only):" >&2
  echo "$STALE" >&2
  fail=1
else
  echo "ok   no stale v0.5.0/v0.6.0/0.0.x references in public docs"
fi

if [ "$fail" -ne 0 ]; then
  echo "Version surfaces drifted — bump all to $VERSION before tagging v$VERSION" >&2
  exit 1
fi

echo "verify-versions: all surfaces aligned at $VERSION"
