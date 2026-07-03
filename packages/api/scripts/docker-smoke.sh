#!/usr/bin/env bash
# Runtime smoke test for the API image. `docker build` only proves the image
# assembles — it does NOT prove the container can start. This catches the class
# of bug where a runtime dependency the bundle externalizes (e.g. jose) is
# missing from the image, which manifests as ERR_MODULE_NOT_FOUND at boot.
#
# Usage: docker-smoke.sh <image-ref>
set -euo pipefail

IMAGE="${1:?usage: docker-smoke.sh <image-ref>}"

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

echo "== smoke A: every runtime dep baked into the image imports =="
# Reads the runtime manifest FROM the image and imports each dependency, so this
# check auto-covers any dependency added later — no hand-maintained list here.
docker run --rm --entrypoint node "$IMAGE" --input-type=module -e '
  import { readFileSync } from "node:fs";
  const deps = Object.keys(JSON.parse(readFileSync("/app/package.json","utf8")).dependencies ?? {});
  if (deps.length === 0) { console.error("no runtime deps in manifest"); process.exit(2); }
  for (const d of deps) { await import(d); }
  console.log("imported OK:", deps.join(", "));
' || fail "a runtime dependency is missing from the image (ERR_MODULE_NOT_FOUND)"

echo "== smoke B: the real entrypoint loads its full module graph =="
# Boot the actual start command with valid env but an unreachable DB. A
# correctly-assembled image loads every module, validates env, parses config,
# and then fails fast at the startup DB probe ("database unreachable"). A broken
# image dies earlier with a module error. We assert the failure is the DB probe,
# NOT a missing module. (If a new REQUIRED env var is added to loadEnv, add it
# here so this still reaches the DB probe.)
OUT="$(docker run --rm \
  -e MODELGOV_CONFIG=/app/modelgov.yaml \
  -e LITELLM_BASE_URL='http://127.0.0.1:1' \
  -e MODELGOV_API_KEY='smoke-test-key' \
  -e DATABASE_URL='postgres://smoke:smoke@127.0.0.1:1/none' \
  -e DB_CONNECTION_TIMEOUT_MS=1500 \
  --entrypoint node "$IMAGE" dist/index.js 2>&1 || true)"

echo "--- entrypoint output ---"
echo "$OUT"
echo "-------------------------"

if grep -qiE 'ERR_MODULE_NOT_FOUND|Cannot find (package|module)' <<<"$OUT"; then
  fail "entrypoint crashed on module resolution — a bundled/external import is missing"
fi
if ! grep -qi 'database unreachable' <<<"$OUT"; then
  fail "entrypoint did not reach the startup DB probe — it crashed before loading fully"
fi

echo "SMOKE PASS: image starts, loads all modules, and fails only at the DB probe as expected"
