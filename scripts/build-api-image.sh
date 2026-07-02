#!/usr/bin/env bash
# Build the Ai-Guard API Docker image.
# Usage: scripts/build-api-image.sh [tag]
#   scripts/build-api-image.sh                    # -> ai-guard-api:local
#   scripts/build-api-image.sh ghcr.io/org/ai-guard-api:1.0.0
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:-ai-guard-api:local}"

cd "$ROOT"
echo "→ Building API image: $TAG"
docker build -t "$TAG" -f packages/api/Dockerfile .
echo "✓ Built $TAG"
