# Changelog

All notable changes to Ai-Guard are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/) across its three compatibility
surfaces — **HTTP API** (`/vN`), **SDKs**, and the **config schema**
(`ai-guard.yaml`). See [docs/versioning.md](docs/versioning.md) for the bump
rules per surface and the supported-version / EOL policy.

Each release lists changes under **Added / Changed / Fixed / Deprecated /
Removed / Security**, and any entry that breaks one of the three surfaces is
called out under **⚠ Breaking** with a migration note. Until 1.0, minor versions
may include breaking changes (standard SemVer 0.x semantics); from 1.0 onward the
guarantees in `docs/versioning.md` apply.

## [Unreleased]

### Added
- **Per-request per-tenant policy resolution** — when `POLICY_STORE_ENABLED` and
  `MULTI_TENANT_POLICY=true`, each request is evaluated against its own tenant's
  active policy version (resolved from the tenant bound to the API key), via a
  TTL cache that is invalidated on activation. The single-tenant / flat path is
  unchanged when the flag is off. (`docs/design/multi-tenancy.md`)
- **Opt-in Postgres row-level security** — `DB_RLS_ENABLED=true` installs a
  tenant-isolation policy on `config_versions` at `migrate` time (kept out of the
  auto-migration chain) and sets `app.current_tenant` per transaction at runtime,
  for defense-in-depth isolation when the app connects as a non-owner DB role.
- **Audit-log export helper** — `scripts/export-audit-log.ts` streams the
  hash-chained `admin_audit_log` as JSONL for WORM/SIEM ingestion and verifies the
  chain, closing the shipped-software gap in the SOC 2 mapping.
- **Compliance evidence-collection guide** — `docs/compliance/evidence-collection.md`
  turns the SOC 2 "operator must evidence" list into a concrete cadence + commands.
- **CHANGELOG** — this file, replacing ad-hoc `RELEASE_NOTES/` as the maintained
  per-release record (GA/1.0 checklist item).

### Changed
- **CI now tests the Python SDK** — `.github/workflows/ci.yml` runs
  `packages/sdk-python` under `pytest` on every push/PR (previously untested in CI).
- **Release automation** — `.github/workflows/release.yml` publishes the four npm
  packages and the Python SDK on a `v*` tag and attaches the versioned
  `openapi.json` as a GitHub Release artifact (the API contract of record per
  `docs/versioning.md`).

### Fixed
- **Docs drift** — `docs/operations.md` no longer contradicts itself on request-log
  retention; the stale "grows without bound / manual DELETE" note is replaced by a
  pointer to the maintenance sweep (`REQUEST_LOG_RETENTION_MS`).

## [0.5.0] - 2026-07-01

First aligned, pinnable release — all packages move to a single `0.5.0` line
(API, CLI, policy-engine, TS SDK, Python SDK, `create-ai-guard`). The flat,
file-config path remains the default; every new capability is opt-in / behind a
flag. Full notes: [`RELEASE_NOTES/v0.5.0.md`](RELEASE_NOTES/v0.5.0.md).

### Added
- **DB-backed API keys** — issue / rotate / revoke without redeploy
  (`/v1/admin/keys`, `ai-guard keys`); only SHA-256 hashes stored at rest.
- **Tamper-evident admin audit log** — hash-chained `admin_audit_log`;
  `GET /v1/admin/audit` + `/verify`; wired to key, policy, and erasure mutations.
- **Versioned policy store** (opt-in, `POLICY_STORE_ENABLED`) — validate →
  activate → rollback, fully audited.
- **GDPR/CCPA erasure endpoint** (`POST /v1/admin/erasure`) + per-feature
  `retention_days`.
- **Response streaming (SSE)**, **OpenTelemetry OTLP export**, and a
  secrets-manager (`*_FILE`) convention — all opt-in.
- **Enterprise control plane** (opt-in, default-off): operator **SSO/OIDC + RBAC**
  and **hierarchical budgets** (node tree, atomic multi-level reservation, counter
  sharding, tenant-bound keys + per-tenant policy versions).
- **Python SDK** (`ai-guard-sdk`) and a **Helm chart** (`deploy/helm/ai-guard`).
- **`config_hash` + `policy_version` on every request log**, surfaced in
  `GET /v1/requests/:id`.

### Changed
- **Safety cost reserved upfront** — the input-safety classifier cost is included
  in the budget reservation (not just settled after), so model + safety can't
  overshoot a cap.
- **Richer SDK errors** — `AiGuardError` exposes `reasonCode`, `auditRequestId`,
  `budgetRemaining`, `feature`, `userType`, `resolvedModelClass`.

### Migration
- Run migrations on deploy (through `0016_token_budgets.sql`). All new subsystems
  are off by default; nothing changes the flat file-config path a `0.0.0` deploy
  relied on.

## [0.0.0] - 2026-06-30

First tagged pre-release, freezing the product state so host-app integration can
proceed against a known baseline. Full notes:
[`RELEASE_NOTES/v0.0.0.md`](RELEASE_NOTES/v0.0.0.md).

### Added
- Core policy pipeline: `policy → explain → validate → test-policy → request
  inspection → usage summary`.
- Real-app integration pattern + event-intake example app.
- Request correlation IDs (`requestId` on success, `auditRequestId` on blocks)
  and host metadata in audit logs.

[Unreleased]: https://github.com/ai-guard/ai-guard/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/ai-guard/ai-guard/compare/v0.0.0...v0.5.0
[0.0.0]: https://github.com/ai-guard/ai-guard/releases/tag/v0.0.0
