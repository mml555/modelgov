# Releasing Modelgov

How to cut a release. **Read [versioning.md](./versioning.md) first** — it
decides *whether* to release and *which digit* to move. This doc is the
mechanics of *how*.

> **TL;DR:** decide the version (patch by default), bump every version surface,
> move `[Unreleased]` → the new section in the CHANGELOG, `pnpm verify`, merge,
> then push the `vX.Y.Z` tag. The tag — not the merge — publishes.

---

## When to release

A release is deliberate, not automatic per PR. Cut one when there is a coherent
set of changes sitting under `[Unreleased]` worth shipping. Pick the version per
[versioning.md](./versioning.md#how-we-choose-the-version-number):

- **PATCH** (`1.6.0 → 1.6.1`) — the default. Fixes, docs, perf, dependency/
  security bumps, and small or gap-filling additive changes.
- **MINOR** (`1.6.0 → 1.7.0`) — only a substantial, announced capability milestone.
- **MAJOR** (`1.6.0 → 2.0.0`) — only a breaking change to the API, SDKs, or config
  schema (with migration notes under **⚠ Breaking** in the CHANGELOG).

## 1. Bump every version surface

All surfaces must match — `scripts/verify-versions.sh` (part of `pnpm verify`)
fails the build if any drift. There are **12**:

| # | File | Field |
| --- | --- | --- |
| 1 | `package.json` | `version` |
| 2 | `packages/api/package.json` | `version` |
| 3 | `packages/policy-engine/package.json` | `version` |
| 4 | `packages/sdk-typescript/package.json` | `version` |
| 5 | `packages/cli/package.json` | `version` |
| 6 | `packages/create-modelgov/package.json` | `version` |
| 7 | `packages/sdk-python/pyproject.toml` | `version` |
| 8 | `packages/sdk-python/modelgov/__init__.py` | `__version__` |
| 9 | `packages/api/src/plugins/openApi.ts` | `OPENAPI_VERSION` |
| 10 | `packages/api/openapi.json` | `info.version` (regenerated — see below) |
| 11 | `deploy/helm/modelgov/Chart.yaml` | `version` **and** `appVersion` |
| 12 | `deploy/helm/modelgov/values.yaml` | `image.tag` (`vX.Y.Z`) |

## 2. Regenerate the OpenAPI spec

`openapi.json` embeds the version from `OPENAPI_VERSION`, so bump surface #9,
then rebuild the API and re-export (the export runs from `dist/`, so a stale
build re-emits the old version):

```bash
pnpm --filter @modelgov/api build
pnpm --filter @modelgov/api openapi:export
```

## 3. Update the CHANGELOG

Move the accumulated `[Unreleased]` entries into a new dated section, and leave
an empty `[Unreleased]` on top:

```md
## [Unreleased]

## [1.6.1] - 2026-07-09
### Fixed
- …
```

Keep-a-Changelog categories: **Added / Changed / Fixed / Deprecated / Removed /
Security**. A breaking change is called out under **⚠ Breaking** with a migration
note.

## 4. Verify

```bash
pnpm verify
```

Runs build, typecheck, lint, file-size caps, package + coverage tests,
`openapi:export`, `verify-versions.sh`, the production doctor, and config
validation. The Python SDK has its own gate (`cd packages/sdk-python &&
python -m pytest`). All must be green.

Then check the price registry against upstream — **required before every
release**:

```bash
node scripts/check-price-drift.mjs
```

Provider rates change on the vendor's schedule, not ours. A stale entry does not
fail any test: budgets still bind, but recorded spend silently diverges from the
real invoice, which is the one thing a cost-governance gateway must not get
wrong. This is deliberately NOT part of `pnpm verify` — upstream changing a price
would red `main` for reasons unrelated to the PR in flight.

Investigate every DRIFTED row before shipping. A name collision (a Modelgov tier
alias that happens to match a different upstream model) belongs in the script's
`ALIAS_COLLISIONS` map with a reason, not in a silent tolerance bump.

**UNVERIFIED rows need attention too.** The script exits 0 for them, because a
missing upstream row is not evidence of drift — but it is not evidence of
correctness either. Those are Modelgov tier aliases (`anthropic/claude-haiku`)
and providers absent from the upstream table (`azure_ai/*`), and nothing checks
them automatically. Confirm each against the vendor's published rate at release
time; a wrong price there fails no test and silently mis-bills. `azure_ai/*` in
particular must stay in step with the matching `azure/*` row — both are Azure
billing, and copying OpenAI-direct rates into them has been a recurring bug.

## 5. PR and merge

`main` is protected — open a PR, get CI green, and resolve every review thread
(branch protection requires conversation resolution). Squash-merge.

## 6. Tag — this is what publishes

```bash
git checkout main && git pull
git tag -a vX.Y.Z -m "modelgov X.Y.Z — <one line>"
git push origin vX.Y.Z
```

Pushing a `v*` tag triggers two workflows:

- **`release.yml`** → publishes npm packages, the PyPI `modelgov` package, and a
  GitHub Release with the `openapi-vX.Y.Z.json` asset attached.
- **`docker.yml`** → builds and pushes the GHCR image `…/modelgov-api:vX.Y.Z`.

> The publish jobs (`npm`, `pypi`) sometimes sit **queued** waiting for runner
> slots after `guard`/`test` pass — that's normal, not a failure.

## 7. Confirm the artifacts

```bash
for pkg in @modelgov/sdk @modelgov/cli @modelgov/policy-engine create-modelgov; do
  echo "$pkg $(npm view "$pkg" version)"
done
curl -s https://pypi.org/pypi/modelgov/json | python -c 'import sys,json; print(json.load(sys.stdin)["info"]["version"])'
gh release view vX.Y.Z --json tagName,isDraft
```

All should report the new version; the GitHub Release should not be a draft.

---

Related: [versioning.md](./versioning.md) (policy), [CONTRIBUTING.md](../CONTRIBUTING.md)
(commits + changelog discipline), [operations.md](./operations.md) (deploy/upgrade).
