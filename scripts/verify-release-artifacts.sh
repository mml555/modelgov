#!/usr/bin/env bash
# Verify published release artifacts exist and match the requested version.
# Usage: scripts/verify-release-artifacts.sh v0.0.0 [GITHUB_REPO]
set -euo pipefail

TAG="${1:?usage: verify-release-artifacts.sh vX.Y.Z [owner/repo]}"
VERSION="${TAG#v}"
REPO="${2:-${GITHUB_REPOSITORY:-mml555/modelgov}}"
IMAGE="${MODELGOV_IMAGE:-ghcr.io/${REPO}/modelgov-api:${TAG}}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Verifying release artifacts for $TAG (repo: $REPO)"

bash scripts/verify-versions.sh

# GitHub release
if command -v gh >/dev/null 2>&1; then
  if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    echo "ok   GitHub release $TAG exists"
  else
    echo "FAIL GitHub release $TAG not found" >&2
    exit 1
  fi
else
  echo "warn gh CLI not installed — skipping GitHub release check"
fi

# Docker image manifest (requires crane or docker)
if command -v crane >/dev/null 2>&1; then
  if crane manifest "$IMAGE" >/dev/null 2>&1; then
    echo "ok   container image $IMAGE"
  else
    echo "FAIL container image not found: $IMAGE" >&2
    exit 1
  fi
elif command -v docker >/dev/null 2>&1; then
  if docker manifest inspect "$IMAGE" >/dev/null 2>&1; then
    echo "ok   container image $IMAGE"
  else
    echo "warn docker manifest inspect failed for $IMAGE (image may be private or missing)"
  fi
else
  echo "warn neither crane nor docker available — skipping image check"
fi

# npm packages (best-effort; may 404 before publish completes)
for pkg in @modelgov/policy-engine @modelgov/sdk @modelgov/cli create-modelgov; do
  if npm view "${pkg}@${VERSION}" version 2>/dev/null | grep -qx "$VERSION"; then
    echo "ok   npm ${pkg}@${VERSION}"
  else
    echo "warn npm ${pkg}@${VERSION} not found (may not be published yet)"
  fi
done

# PyPI
if command -v curl >/dev/null 2>&1; then
  if curl -sf "https://pypi.org/pypi/modelgov/${VERSION}/json" >/dev/null; then
    echo "ok   PyPI modelgov $VERSION"
  else
    echo "warn PyPI modelgov $VERSION not found (may not be published yet)"
  fi
fi

# OpenAPI artifact on release
if command -v gh >/dev/null 2>&1; then
  if gh release view "$TAG" --repo "$REPO" --json assets -q '.assets[].name' 2>/dev/null | grep -qx "openapi-${TAG}.json"; then
    echo "ok   openapi-${TAG}.json attached to release"
  else
    echo "warn openapi-${TAG}.json not found on GitHub release assets"
  fi
fi

echo "verify-release-artifacts: done for $TAG"
