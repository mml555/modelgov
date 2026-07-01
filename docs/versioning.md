# Versioning, compatibility & release policy

How Ai-Guard versions its **HTTP API**, **SDKs**, and **config schema**; the
supported-version window; and the compatibility guarantees you can build on.

> **Status:** Ai-Guard is pre-1.0. [SECURITY.md](../SECURITY.md) lists **0.1.x**
> as the only supported line (active development). The policy below is the
> **intended policy from 1.0 onward**; while pre-1.0, minor versions may include
> breaking changes (standard SemVer 0.x semantics). This document also defines the
> checklist to cut a stable 1.0.

---

## SemVer, applied to three surfaces

Ai-Guard follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).
It has three independently meaningful compatibility surfaces:

### 1. HTTP API

The wire contract at `/v1/*`: routes, request/response shapes, error envelope,
status codes, and the **stable `reasonCode` values** in
[failure-semantics.md](./failure-semantics.md).

| Change | Bump |
| --- | --- |
| Add an optional request field, a new endpoint, a new optional response field | **MINOR** |
| Add a new `reasonCode` or error `code` | **MINOR** (consumers must tolerate unknown codes) |
| Remove/rename a field; change a status code for an existing case; change a documented `reasonCode`'s meaning; make an optional field required | **MAJOR** |
| Bug fix that does not change the contract | **PATCH** |

The URL carries the **API major** (`/v1`). A breaking API change introduces
`/v2` and is supported alongside `/v1` for the deprecation window below — the path
prefix, not just the package version, is the API's compatibility promise.
`GET /openapi.json` is the machine-readable source of truth for a running server.

**Explicitly stable (won't break within a major):** the `error` envelope shape
(`code`, `message`, `details`, `requestId`), the block-error top-level fields
(`decision`, `reasonCode`, `budgetRemaining`, `auditRequestId`), request-ID header
`x-ai-guard-request-id`, and existing `reasonCode` string values.

### 2. SDKs (`@ai-guard/sdk` and generated types)

npm packages follow SemVer against their **public TypeScript API**
(`createAiGuardClient`, method signatures, exported types/errors).

| Change | Bump |
| --- | --- |
| Add a method or optional option | **MINOR** |
| Change/remove a signature or exported type; drop a runtime/Node version | **MAJOR** |

The SDK generates `FeatureName` / `UserTypeName` / `ModelClassName` unions from
**your** `ai-guard.yaml` (`pnpm generate-sdk-types`). Those types reflect your
config, not the library version — regenerating after a config change is expected
and is not an SDK breaking change.

**SDK ↔ API compatibility:** an SDK targets an API **major**. A given SDK minor
works against any API server of the same major at ≥ the API minor it was built
for (forward-compatible: servers add optional fields). Pin the SDK major to your
API major.

### 3. Config schema (`ai-guard.yaml`)

The policy file is a compatibility surface for operators.

| Change | Bump |
| --- | --- |
| Add an optional key with a safe default | **MINOR** |
| Remove/rename a key, change a default that alters enforcement, tighten validation so a previously valid file is rejected | **MAJOR** |

Validate before deploy with `pnpm ai-guard validate --config ai-guard.yaml
--production`. `litellm_config.yaml` is **generated** from `ai-guard.yaml` and is
not a hand-editable compatibility surface.

---

## Supported-versions window & EOL

> Intended from 1.0. Current pre-1.0 support is **0.1.x only** per SECURITY.md.

| Line | Support |
| --- | --- |
| **Current major** (latest minor) | Full support: features, fixes, security patches |
| **Previous major** | Security + critical fixes for **≥ 6 months** after the next major GA (EOL date announced at that GA) |
| **Older majors** | Unsupported (EOL) |
| **Pre-1.0 (0.x)** | Only the latest 0.x minor is supported; minors may break |

- **Security patches** land on the current major and any in-window previous
  major. Report privately per [SECURITY.md](../SECURITY.md).
- **API `/vN` sunset:** when `/v(N+1)` ships, `/vN` is supported for the previous-
  major window above, with a deprecation notice in release notes and (where
  feasible) response headers before removal.
- **EOL definition:** no further releases (including security) for that major.

---

## Upgrade & migration guarantees

- **Database migrations run forward automatically and are safe under concurrency**
  — serialized across replicas via a Postgres advisory lock; the default image
  entrypoint runs `migrate && start`, or run `node dist/migrate.js` as a
  standalone init job. See [operations upgrades](./operations.md#upgrades) and the
  [HA migration pattern](./deployment/high-availability.md#migration-init-job-pattern).
- **No automated schema downgrades.** Roll back via a Postgres restore (see
  [DR runbook](./runbooks/disaster-recovery.md)); always back up before upgrading.
- **Rolling upgrades within a major** are supported (stateless API replicas +
  backward-compatible migrations). Across a major, follow the release notes'
  migration guide.
- **Images are immutable and pinned** — no floating `:latest`; pin by tag or, best,
  by digest. Every breaking change ships with a **CHANGELOG entry + migration
  notes** — see [CHANGELOG.md](../CHANGELOG.md) (breaking entries are marked
  **⚠ Breaking** with a migration note).
- **Deprecation before removal:** a feature/field is marked deprecated for at
  least one MINOR release (with a documented replacement) before a MAJOR removes it.

---

## Checklist to cut a stable 1.0

What must be **frozen and guaranteed** before declaring 1.0. Until every box is
checked, breaking changes remain possible under 0.x semantics.

**API contract**

- [ ] Freeze `/v1` route set, request/response schemas, and status-code mapping.
- [ ] Freeze the error-envelope shape and the full `reasonCode` enumeration as
      append-only.
- [x] Publish `openapi.json` as a versioned artifact per release; treat it as the
      contract of record — the `release` workflow attaches `openapi-<tag>.json` to
      each GitHub Release (`.github/workflows/release.yml`).
- [ ] Confirm no known breaking API change is pending (e.g. actor/subject model is
      explicitly **post-v1** and must stay additive).

**SDK**

- [ ] Freeze the public `@ai-guard/sdk` surface (methods, options, exported types,
      error classes).
- [ ] Document the SDK-major ↔ API-major support matrix.
- [ ] Pin and document the supported Node/runtime range.

**Config schema**

- [ ] Freeze `ai-guard.yaml` key names and enforcement-affecting defaults.
- [ ] Ship a schema version or validation that rejects unknown keys predictably.
- [ ] Document every field's default and its bump class (MINOR-add vs MAJOR-change).

**Migrations & data**

- [ ] Confirm forward migrations are idempotent and advisory-locked (done).
- [ ] Document the backup-before-upgrade requirement and rollback-via-restore path.

**Process & docs**

- [x] Adopt a maintained **CHANGELOG** with a breaking-changes section per release
      — [CHANGELOG.md](../CHANGELOG.md) (Keep a Changelog format; **⚠ Breaking**
      entries carry migration notes).
- [ ] Publish the deprecation policy (≥1 MINOR notice) and the supported-version
      window with concrete EOL dates.
- [ ] Update [SECURITY.md](../SECURITY.md) supported-versions table from `0.1.x`
      to the 1.x support window.
- [ ] Define the `/v1 → /v2` coexistence + sunset procedure before the first
      breaking API change lands.

**Known post-v1 items (intentionally deferred, must stay additive):** response
streaming (SSE), actor/subject policy model, global-counter sharding, routing
experiments/weighted rotation. These are documented as not-in-v1 and 1.0 must not
depend on them; when they land they must be backward-compatible additions.

Related: [operations](./operations.md), [API reference](./api.md),
[failure semantics](./failure-semantics.md), [SECURITY.md](../SECURITY.md).
