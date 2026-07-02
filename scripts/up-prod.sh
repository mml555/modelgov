#!/usr/bin/env bash
# Production launcher — pinned images or local build.
#   cp ai-guard.production.example.yaml ai-guard.yaml   # customize policy
#   cp .env.production.example .env.production          # fill secrets
#   # Option A: set AI_GUARD_API_IMAGE to your registry image (digest preferred)
#   # Option B: AI_GUARD_API_IMAGE=ai-guard-api:local && BUILD_LOCAL_IMAGE=true
#   make up-prod
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-.env.production}"
if [ ! -f "ai-guard.yaml" ]; then
  echo "Missing ai-guard.yaml — copy from ai-guard.production.example.yaml and customize."
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — copy from .env.production.example and fill secrets."
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

IMAGE="${AI_GUARD_API_IMAGE:-}"
if [ -z "$IMAGE" ] || [ "$IMAGE" = "your-registry/ai-guard-api:1.0.0" ]; then
  if [ "${BUILD_LOCAL_IMAGE:-false}" = "true" ]; then
    IMAGE="ai-guard-api:local"
    export AI_GUARD_API_IMAGE="$IMAGE"
  else
    echo "Set AI_GUARD_API_IMAGE in $ENV_FILE, or BUILD_LOCAL_IMAGE=true with ai-guard-api:local."
    exit 1
  fi
fi

if [ "${BUILD_LOCAL_IMAGE:-false}" = "true" ] || [ "$IMAGE" = "ai-guard-api:local" ]; then
  bash scripts/build-api-image.sh "$IMAGE"
fi

echo "→ Starting Ai-Guard (production compose) with image $IMAGE..."
docker compose --env-file "$ENV_FILE" -f docker-compose.production.yml up -d

PORT="${AI_GUARD_PUBLIC_PORT:-3000}"
echo "→ Waiting for /ready..."
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:${PORT}/ready" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo ""
echo "✓ Ai-Guard API:  http://localhost:${PORT}"
echo "  Health: GET /health   Readiness: GET /ready"
echo "  Stop:   make down-prod"
echo ""
