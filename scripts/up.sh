#!/usr/bin/env bash
# Compatibility wrapper for the Modelgov CLI ops surface.
# Usage: scripts/up.sh [simple|full|local]
set -euo pipefail

MODE="${1:-simple}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

exec pnpm --filter @modelgov/cli dev -- up "$MODE"
