# Changelog

All notable changes to Modelgov are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/) across its three compatibility
surfaces — **HTTP API** (`/vN`), **SDKs**, and the **config schema**
(`modelgov.yaml`). See [docs/versioning.md](docs/versioning.md) for the bump
rules per surface and the supported-version / EOL policy.

Each release lists changes under **Added / Changed / Fixed / Deprecated /
Removed / Security**, and any entry that breaks one of the three surfaces is
called out under **⚠ Breaking** with a migration note. Until 1.0, minor versions
may include breaking changes (standard SemVer 0.x semantics); from 1.0 onward the
guarantees in `docs/versioning.md` apply.

## [Unreleased]

## [1.0.1] - 2026-07-03

### Fixed
- **`create-modelgov` was unrunnable via `npx`**: the built `dist/index.js` was
  missing its `#!/usr/bin/env node` shebang, so the `create-modelgov` bin was
  executed as a shell script (`syntax error near '\n'`) instead of by Node. Added
  the shebang to the source (tsup preserves it). No other package was affected
  (`@modelgov/cli` already had one). `create-modelgov@1.0.0` should be treated as
  broken — use `1.0.1`.

## [1.0.0] - 2026-07-02

First stable, public release under the MIT license. From this version the
compatibility guarantees in [docs/versioning.md](docs/versioning.md) are in
effect: breaking changes to the HTTP API, SDKs, or config schema require a new
major version. This release consolidates the production-readiness hardening and
multi-tenant isolation below with the embeddings / vision / grounding gateway
extensions and reproducible container builds added since 0.6.0.

Production-readiness hardening from the 2026-07-01 full audit. Multi-tenant
isolation is now real end-to-end, the money path no longer leaks or
double-books, and the operator console, observability, and migration
operability are completed.

### Security
- **Multi-tenant isolation across every previously-shared surface.** Budget
  nodes, admin API keys, idempotency keys, flat budget counters (incl.
  `global_monthly`), and the admin audit log are all now scoped to the caller's
  tenant. A tenant can no longer bill, read, enumerate, replay, or disrupt
  another tenant's data; cross-tenant probes return the same not-found response
  as truly-absent resources (no existence oracle).
- **API-key privilege ceiling.** A key-admin can no longer mint a key for
  another tenant or grant control-plane permissions (`keys:admin`, `policy:*`,
  `data:erase`, `audit:read`, `usage:read`, `requests:read`) it does not itself
  hold. `chat:create` remains freely grantable.
- **Helm:** removed the shipped-default LiteLLM master key (now required, with a
  production render guard against the old default) and added a NetworkPolicy
  that restricts the LiteLLM/Redis/Presidio sidecars to the API pod.
- **Config is validated strictly:** a misspelled cap key (e.g. `montly_usd`) is
  now a hard error instead of silently falling back to a default — a mistyped
  budget can never fail open.
- Admin audit rows now carry `tenant_id`, folded into the tamper-evident hash
  chain.

### Fixed
- **Streaming budget leak:** a stream aborted by the client or interrupted
  mid-generation now bills the tokens actually produced (capped at the
  reservation) instead of refunding the entire hold.
- **Hierarchical policy blocks are honored:** a blocked request (disabled tier,
  per-request cap breach, data sensitivity) is rejected with `403` and never
  reaches the provider or ships `decision: "block"` in a `200` body.
- **Settlement is idempotent:** a retried cost settlement can no longer
  double-book `used_usd` (the reservation lease is the single-use token for the
  whole settle).
- **GDPR erasure** deletes in bounded batches (a heavy user can always be
  erased) and now also covers in-flight reservation leases.
- Non-UTC servers no longer misread hierarchical budget window dates.
- Operator console pages aligned to the real API response shapes (`keyPrefix`,
  `actualCostUsd`, `timestamps.createdAt`, usage-summary fields) and the login
  API-URL is now honored/persisted; a turnkey nginx container is provided.
- Flagship examples no longer crash on the block path; scaffolder and docs no
  longer advertise unpublished install commands without a caveat.

### Added
- **Gateway extensions:** governed embeddings (`POST /v1/embeddings`), vision /
  multimodal chat (image content parts), and a grounding safety mode that
  citation-verifies answers against caller-supplied `context`; plus a `pii_scope`
  control (input / output / both) for PII masking. Both SDKs updated.
- **Domain metrics** on `/metrics`: `modelgov_chat_requests_total`,
  `modelgov_chat_cost_usd_total`, `modelgov_chat_fallbacks_total`,
  `modelgov_budget_blocks_total`, `modelgov_safety_blocks_total`.
- **Request-log correlation:** one id per request across pino logs (`reqId`),
  the error-envelope `requestId`, and the `x-modelgov-request-id` header;
  configurable `LOG_LEVEL`.
- Python SDK ships a PEP 561 `py.typed` marker so consumer type checkers use its
  annotations.
- Operator console `Dockerfile` (non-root nginx, SPA fallback) and runtime-
  configurable API URL.

### Changed
- Migrations run with statement/query timeouts disabled so a long index build or
  advisory-lock wait on a large database is never killed at 30s.
- **Reproducible runtime image:** the API container's dependencies are now
  resolved entirely from the workspace lockfile (`pnpm deploy`) rather than
  re-resolved at build time, so the same commit yields the same dependency tree.

### ⚠ Breaking
- **Config schema:** unknown/misspelled top-level or budget keys in
  `modelgov.yaml` are now rejected (previously ignored). Validate with
  `modelgov validate --production` before upgrading.
- **HTTP API:** `POST /v1/chat` success responses return `budgetRemaining: null`
  under hierarchical budgets (the node tree is the authority) instead of a
  fabricated flat figure. The field is now nullable in the OpenAPI spec.
- **Database:** three additive migrations (`0020`–`0022`) add tenant dimensions
  to `idempotency_keys`, `budget_counters` (+ reservation leases), and
  `admin_audit_log`, changing their primary keys. Forward-only; existing rows
  default to the untenanted (`''`) partition.

## [0.0.0] - 2026-07-01

**Pre-release baseline.** All publishable version surfaces aligned at `0.0.0`
before the first public release line. Prior internal milestone tags (`v0.5.0`,
`v0.6.0`) are superseded for semver purposes. Full notes:
[`RELEASE_NOTES/v0.0.0.md`](RELEASE_NOTES/v0.0.0.md).

## [0.6.0] - 2026-07-01

**Trustworthy audit trail and cost ledger.** Remediation release from the
2026-07-01 codebase review: policy blocks on fallback re-evaluation are
enforced, every rejection path is audited, classifier spend is booked on
blocks, and idempotency replays expire. Full notes:
[`RELEASE_NOTES/v0.6.0.md`](RELEASE_NOTES/v0.6.0.md).

### ⚠ Breaking (0.x behavior changes)
- **Fallback data-sensitivity blocks are enforced** — when the primary provider
  fails and the fallback model's provider is not approved for the feature's
  data class, the request now returns `403 policy_blocked`
  (`data_sensitivity_not_permitted`). Previously the block was silently
  ignored: the failed primary was retried and the audit log recorded
  `decision: "fallback"` for a fallback that never ran. Clients handling only
  `502` on provider outages should also handle this 403.
- **Classifier spend is booked on rejected requests** — the input-safety
  classifier's real provider cost lands in `used_usd` on every path where it
  was incurred (safety block, reservation failure, top-up failure, provider
  failure), and the audit row carries it as `actual_cost_usd`. Booking never
  gates: a safety block stays `403 safety_blocked` even if the spend pushes a
  counter past its cap. (`docs/failure-semantics.md`)
- **Completed idempotency replays expire after 7 days** (configurable via
  `IDEMPOTENCY_COMPLETED_RETENTION_MS`) — replaying an older key re-executes
  the request instead of returning the cached result. Previously replays were
  retained indefinitely (and the table grew without bound).
- **Error envelopes** — hierarchical and streaming rejections now include
  `auditRequestId` like the flat path; hierarchical policy-block errors no
  longer report flat `budgetRemaining` (it was computed against zero usage and
  claimed full headroom while the node tree is the real authority).

### Added
- **Rejection audit invariant** — every 4xx/5xx rejection writes a
  `request_logs` row (the fallback top-up failure and streaming
  reservation-failure paths previously wrote none), enforced by a dedicated
  integration suite.
- **`IDEMPOTENCY_COMPLETED_RETENTION_MS`** (default 7d) + migration
  `0017_idempotency_completed_idx.sql`; the maintenance sweep prunes completed
  replay rows in bounded batches.
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
- **Chat request lifecycle extracted** — failure semantics (audit trio,
  incur-then-release ordering, the fallback block check, provider execution
  with fallback) live once in `chat/lifecycle.ts` and are composed by the flat,
  hierarchical, and streaming handlers. Shared API-key scope checks live in
  `authz/scope.ts`.
- **Coverage gate measures the whole API surface** — previously a 19-file
  allow-list reported 95.7% while chat, db, and services went unmeasured;
  thresholds now reflect reality (81/72/89) and ratchet up only.
- **CI runs the policy regression suite** (`modelgov.policy-tests.yaml`) and
  **Trivy scans all Docker builds** (previously PRs only), pinned to the
  release commit SHA.
- **Production defaults hardened** — `.env.production.example` ships
  `DATABASE_SSL=require`; LiteLLM/Presidio have healthchecks with
  `service_healthy` gating; boot warns when OIDC is enabled without
  `OIDC_AUDIENCE`.
- **CI now tests the Python SDK** — `.github/workflows/ci.yml` runs
  `packages/sdk-python` under `pytest` on every push/PR (previously untested in CI).
- **Release automation** — `.github/workflows/release.yml` publishes the four npm
  packages and the Python SDK on a `v*` tag and attaches the versioned
  `openapi.json` as a GitHub Release artifact (the API contract of record per
  `docs/versioning.md`).

### Fixed
- **Settlement retry after a fallback top-up** released only the original
  reservation, stranding the top-up portion in `reserved_usd` with its lease
  already deleted.
- **Docs drift** — `docs/operations.md` no longer contradicts itself on request-log
  retention; `docs/failure-semantics.md` documents the fallback data-sensitivity
  block and adds `data_sensitivity_not_permitted` to the stable `reasonCode` table.

### Migration
- Run migrations on deploy (through `0017_idempotency_completed_idx.sql`).
- New env vars are optional with safe defaults. Review the ⚠ Breaking list if
  clients depend on fallback-outage status codes, indefinite idempotent
  replays, or exact budget arithmetic around blocked requests.

## [0.5.0] - 2026-07-01

First aligned, pinnable release — all packages move to a single `0.5.0` line
(API, CLI, policy-engine, TS SDK, Python SDK, `create-modelgov`). The flat,
file-config path remains the default; every new capability is opt-in / behind a
flag. Full notes: [`RELEASE_NOTES/v0.5.0.md`](RELEASE_NOTES/v0.5.0.md).

### Added
- **DB-backed API keys** — issue / rotate / revoke without redeploy
  (`/v1/admin/keys`, `modelgov keys`); only SHA-256 hashes stored at rest.
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
- **Python SDK** (`modelgov`) and a **Helm chart** (`deploy/helm/modelgov`).
- **`config_hash` + `policy_version` on every request log**, surfaced in
  `GET /v1/requests/:id`.

### Changed
- **Safety cost reserved upfront** — the input-safety classifier cost is included
  in the budget reservation (not just settled after), so model + safety can't
  overshoot a cap.
- **Richer SDK errors** — `ModelgovError` exposes `reasonCode`, `auditRequestId`,
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

[Unreleased]: https://github.com/mml555/modelgov/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/mml555/modelgov/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/mml555/modelgov/releases/tag/v1.0.0
[0.6.0]: https://github.com/mml555/modelgov/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mml555/modelgov/compare/v0.0.0...v0.5.0
[0.0.0]: https://github.com/mml555/modelgov/releases/tag/v0.0.0
