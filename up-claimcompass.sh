#!/usr/bin/env bash
# Bring up the gateway for ClaimCompass: the simple stack + the Tesseract OCR
# sidecar, minus the operator console.
#
# The console is skipped deliberately, not forgotten: apps/operator-console's
# Dockerfile runs `pnpm install` over the workspace before the sources are
# COPY'd, so policy-engine's `prepare` script (tsup src/index.ts) fails with
# "Cannot find src/index.ts" and the image never builds. packages/api/Dockerfile
# avoids this with --ignore-scripts. Until that is fixed upstream, use
# ./apply-policy.sh instead of the console to push policy changes.
set -euo pipefail
cd "$(dirname "$0")"

SERVICES=(postgres litellm presidio-analyzer presidio-anonymizer demo-llm tesseract-ocr api)
COMPOSE=(docker compose -f docker-compose.simple.yml -f docker-compose.claimcompass.yml)

echo "→ building + starting: ${SERVICES[*]}"
"${COMPOSE[@]}" up -d --build "${SERVICES[@]}"

echo "→ waiting for /ready"
for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:3090/ready >/dev/null 2>&1; then
    curl -s http://127.0.0.1:3090/ready
    echo
    echo "✓ gateway ready on http://127.0.0.1:3090"
    exit 0
  fi
  sleep 1
done

echo "up-claimcompass: not ready after 60s. Check: docker compose -f docker-compose.simple.yml -f docker-compose.claimcompass.yml logs api" >&2
exit 1
