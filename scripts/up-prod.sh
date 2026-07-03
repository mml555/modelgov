#!/usr/bin/env bash
# Production launcher — pinned images or local build.
#   cp modelgov.production.example.yaml modelgov.yaml   # customize policy
#   cp .env.production.example .env.production          # fill secrets
#   # Option A: set MODELGOV_API_IMAGE to your registry image (digest preferred)
#   # Option B: MODELGOV_API_IMAGE=modelgov-api:local && BUILD_LOCAL_IMAGE=true
#   make up-prod
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-.env.production}"
if [ ! -f "modelgov.yaml" ]; then
  echo "Missing modelgov.yaml — copy from modelgov.production.example.yaml and customize."
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

IMAGE="${MODELGOV_API_IMAGE:-}"
if [ -z "$IMAGE" ] || [ "$IMAGE" = "your-registry/modelgov-api:1.0.0" ]; then
  if [ "${BUILD_LOCAL_IMAGE:-false}" = "true" ]; then
    IMAGE="modelgov-api:local"
    export MODELGOV_API_IMAGE="$IMAGE"
  else
    echo "Set MODELGOV_API_IMAGE in $ENV_FILE, or BUILD_LOCAL_IMAGE=true with modelgov-api:local."
    exit 1
  fi
fi

if [ "${BUILD_LOCAL_IMAGE:-false}" = "true" ] || [ "$IMAGE" = "modelgov-api:local" ]; then
  bash scripts/build-api-image.sh "$IMAGE"
fi

echo "→ Starting Modelgov (production compose) with image $IMAGE..."
docker compose --env-file "$ENV_FILE" -f docker-compose.production.yml up -d

PORT="${MODELGOV_PUBLIC_PORT:-3000}"
echo "→ Waiting for /ready..."
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:${PORT}/ready" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo ""
echo "✓ Modelgov API:  http://localhost:${PORT}"
echo "  Health: GET /health   Readiness: GET /ready"
echo "  Stop:   make down-prod"
echo ""
