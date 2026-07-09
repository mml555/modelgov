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

## [1.7.0] - 2026-07-09

### Added

- **First-run browser setup wizard.** A guided, no-YAML setup for non-technical
  operators, reached automatically on first run of the operator console
  (`/setup`). The recommended quick-start connects a **real** provider (OpenAI
  preset — support-chat template, balanced safety, $200/mo cap) so budgets and
  cost governance are real from the first request; a built-in demo (no key) is
  available as a secondary "just exploring" option. For cloud providers the
  wizard saves keys to `.env`, generates the LiteLLM config, and **auto-restarts
  the model proxy** (via the Docker socket on the local dev stack) so keys go
  live with no terminal command — falling back to a one-line
  `pnpm modelgov reload-providers` (with a copy button) if the socket isn't
  available. The done step auto-runs a test message so you see the AI reply, and
  `./setup` opens the console in your browser. `policyMerge` preserves the
  running gateway's boot-only fields on apply, and hybrid prompt-injection
  guidance is surfaced for cloud + non-dev safety.
  - **Security:** setup writes only allowlisted provider-credential env vars
    (never `DATABASE_URL`/`MODELGOV_API_KEY`), rejects newline-injecting values,
    creates `.env` `0o600`, scopes provider secrets to the LiteLLM container
    (not `env_file: .env`), and time-boxes the Docker-socket + probe calls. The
    socket mount + root are **local-dev-only** (never prod compose or Helm) and
    the setup API is disabled when `MODELGOV_PRODUCTION=true`.

### Changed

- **Versioning is now patch-by-default.** Backward-compatible changes — including
  small or gap-filling additive changes — ship as **PATCH**; **MINOR** is
  reserved for substantial, announced capability milestones; **MAJOR** for
  breaking changes only. Releases are batched (accumulated under `[Unreleased]`
  and cut deliberately) rather than one-per-PR. This is stricter than textbook
  SemVer on the minor digit but preserves the same compatibility contract.
  Rationale and mechanics: [docs/versioning.md](docs/versioning.md) and the new
  [docs/releasing.md](docs/releasing.md). (Releases `1.1`–`1.6` predate this and
  stand.)
- **Contribution conventions documented.** [CONTRIBUTING.md](CONTRIBUTING.md) now
  specifies the Conventional Commits format, the "update docs in the same PR"
  rule, and CHANGELOG-per-change discipline; the PR template gained a
  **version-impact** section.

### Fixed

- **`verify-versions` now checks `packages/api/package.json`.** It was omitted
  from the guard, so a stale API package version (which ships in the Docker
  image) could pass `pnpm verify` and the tag guard undetected. All listed
  version surfaces are now enforced.
- **The release workflow gates the PyPI publish on the Python SDK tests.**
  `release.yml`'s `pypi` job now runs `pytest` before building/publishing, so a
  tag can no longer ship a Python package whose tests fail.

## [1.6.0] - 2026-07-09

### Added

- **SDKs — admin/usage API coverage + request correlation (Python + TypeScript).**
  Both clients gained `getUsageTransactions` / `get_usage_transactions`
  (`GET /v1/usage/transactions` — the per-transaction cost rollup grouped by
  `correlationId`, LLM vs externally-ingested cost broken out) and
  `getProviderHealth` / `get_provider_health` (`GET /v1/admin/providers/health` —
  per-provider/model health from the LiteLLM proxy). The TypeScript SDK also
  gained `getUsage` / `getUsageSummary` (previously Python-only). All require the
  `usage:read` permission. New typed results are exported:
  `Transaction`/`TransactionsResponse` and `ProviderModelHealth`/
  `ProviderHealthResponse` (TS), and the `TransactionsResult` /
  `ProviderHealthResult` aliases (Python).
- **SDKs — request correlation.** `chat`, `chat_stream`/`chatStream`, `embed`,
  `explain`, and `extract_document`/`extractDocument` accept an optional
  `request_id` / `requestId` that sets the `x-request-id` header. Passing the
  same value across related calls rolls them up into one transaction in the
  transactions rollup (the gateway reuses a bounded inbound `x-request-id`,
  ≤128 chars, as the correlation id, echoed on `x-modelgov-request-id`).

### Fixed

- **Docs freshness.** Corrected stale "current release `v1.3.0`" pins and the
  `openapi-v1.3.0.json` asset reference to the current release, and removed the
  "not yet published to npm/PyPI" note now that `@modelgov/sdk`, `create-modelgov`,
  and `modelgov` (PyPI) are published.

## [1.5.0] - 2026-07-09

### Added

- **Azure Document Intelligence model selection + structured output.**
  `POST /v1/documents/extract` accepts an optional `model` (default
  `prebuilt-read`): `prebuilt-layout` (tables/structure), `prebuilt-invoice`,
  `prebuilt-receipt`, `prebuilt-idDocument`, `prebuilt-bankStatement.us`, or a
  custom model id. The response now carries structure-aware output — **`tables`**,
  **`fields`** (key/value pairs), and **`documents`** (prebuilt-model fields) —
  alongside `text`/`pages`. The TypeScript (`extractDocument` `model` +
  `tables`/`fields`/`documents`) and Python (`extract_document`) SDKs are updated.
  Providers without model selection (Tesseract, Textract) reject a `model` with
  `400 unsupported_model`. Output PII handling applies to the structured fields
  too: in `mask` mode the structured output is withheld (it would carry unmasked
  PII); use `pii: off` or `pii: block` for structured extraction.

### Changed

- Azure DI cost is now **per-model**: `AZURE_DI_MODEL_PRICES` (comma-separated
  `model:usd`) overrides `DOCUMENT_PRICE_PER_PAGE_AZURE_DI` per model (layout /
  prebuilt-* / custom bill higher than read); the reserve/settle uses the
  requested model's rate.

## [1.4.0] - 2026-07-08

### Added

- **Cost attribution & correlation.** Every `request_logs` row now carries a
  `correlation_id` (from the reused `x-request-id`), so many gateway calls roll
  up as one business transaction. New `GET /v1/usage/transactions` returns a
  per-transaction cost rollup (LLM + external, broken out), and
  `POST /v1/usage/external` (permission **`usage:write`**) records externally-
  tracked non-LLM cost against a transaction. The operator console gains a "Cost
  by transaction" view and a correlation filter on the Requests explorer.
- **Governed document extraction.** `POST /v1/documents/extract` proxies
  OCR / document-AI providers — **Tesseract** (self-hosted sidecar), **Azure
  Document Intelligence**, and **Amazon Textract** — as first-class governed
  calls: budget-reserved per page, PII-masked on the extracted text, audited,
  and idempotent (`Idempotency-Key`). Textract is signed with an in-house AWS
  SigV4 signer (no AWS SDK dependency). See `docs/design/document-ai.md`.
- **SDK support** for document extraction: `extractDocument` (TypeScript) and
  `extract_document` (Python).

### Changed

- New config/env: `EXTERNAL_COST_SOURCES`, `EXTERNAL_COST_MAX_USD`,
  `TESSERACT_URL`, `AZURE_DI_ENDPOINT` / `AZURE_DI_KEY`, `TEXTRACT_REGION`
  (+ standard AWS creds), `TEXTRACT_S3_ALLOWED_BUCKETS`,
  `DOCUMENT_PRICE_PER_PAGE_*`, `DOCUMENT_MAX_PAGES`. New permission `usage:write`,
  granted to the `finops` and `owner` roles.

### Security

- Caller-supplied document `url` sources are fetched through an SSRF-guarded
  dispatcher whose **connect-time** lookup rejects private/link-local addresses
  (the address validated is the address connected to, closing the DNS-rebinding
  TOCTOU), and HTTP redirects are not followed.
- Textract `s3://` sources are gated by a `TEXTRACT_S3_ALLOWED_BUCKETS` allowlist,
  fail-closed (unset ⇒ rejected) — the gateway reads S3 with its own credentials,
  so an unrestricted `s3` source would be a confused-deputy read of arbitrary
  internal/tenant buckets.

### Fixed

- Document budget reservations are floored at a worst-case page count, so a
  caller can't under-report `pages` to slip a large document past a budget cap.
- Audit-write failures that occur after a provider call has settled are now
  non-retryable, so an idempotent retry cannot re-call the provider and
  re-charge (documents and embeddings).
- Azure DI poll `4xx` responses are classified as (non-retryable) client errors;
  gateway `url` document fetches are size-capped while streaming (no unbounded
  buffering); the credit hold is settled rather than leaked on an unexpected
  safety-backend error.
- Externally-ingested cost rows are excluded from LLM request counts in
  `/v1/usage/summary`, `/v1/usage/transactions`, and the default `/v1/requests`
  list. A `(tenant_id, created_at)` index backs the time-window aggregates.

## [1.3.0] - 2026-07-08

### Added

- **First-class multi-provider support.** A new provider registry
  (`@modelgov/policy-engine`'s `providers.ts`) is the single source of truth for
  each provider's auth style, billing style, credential env vars, and built-in
  prices. Adds turnkey support (built-in pricing + wizard presets + docs) for
  **AWS Bedrock, Google Vertex, Mistral, Groq, xAI (Grok), DeepSeek, Cohere, and
  GitHub Copilot**, alongside the existing OpenAI/Anthropic/Gemini/OpenRouter/
  Azure/Azure AI Foundry. Any LiteLLM-backed provider still works; these are just
  wired end-to-end.
- **Subscription billing semantics.** Providers billed per-seat (GitHub Copilot,
  or any provider marked `providers.<id>: { billing: subscription }`) reserve
  **$0 USD** — they have no per-token cost — while **token and request budgets**
  still enforce. Recognized automatically for `github_copilot` via the registry.
- **Widened `providers:` schema.** Provider entries accept `api_base`,
  `api_version`, `region`, `project`, `location`, `auth`, and `billing` (all
  optional; existing `{ api_key }` configs are unchanged). `.strict()` so a
  misspelled key is a loud error.
- **`GET /v1/admin/providers/health`** (requires `usage:read`) surfaces the
  LiteLLM proxy's per-model health (which provider/model is up/down, with the
  provider error). Read-only; does not affect the `/ready` gate.
- **`create-modelgov` wizard** now offers all registered providers and generates
  the correct LiteLLM `litellm_params` per auth kind (AWS creds for Bedrock,
  `vertex_project`/`vertex_location` for Vertex, model-only for Copilot's OAuth
  device flow, `api_key` for the rest).

### Changed

- The env-credential allowlist for `providers.*` `env/VAR` refs now also admits
  the credential vars of any **registered provider** (e.g. `AWS_ACCESS_KEY_ID`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `AZURE_API_BASE`, `GITHUB_COPILOT_TOKEN`) in
  addition to the `*_KEY` suffix and `MODELGOV_POLICY_ENV_ALLOWLIST`. Gateway
  secrets remain always-denied. `modelgov validate --production` now checks every
  `env/` credential ref on a provider (not just `api_key`).

### ⚠ Breaking

- **`image_url` in chat/vision content is restricted to `data:` and `https:`
  URLs.** The upstream provider/vision backend dereferences the URL, so an
  arbitrary `http(s)` URL pointing at an internal address (e.g.
  `http://169.254.169.254/…`) was a server-side request forgery (SSRF) vector
  executed from inside the deployment's network. A cleartext `http:` or non-URL
  image reference is now rejected with `400`. Inline `data:` URIs and public
  `https:` URLs are unaffected.
- **Operator SSO in production now requires `OIDC_ROLE_MAP`.** Without it, IdP
  role/group claim values were used as Modelgov role names verbatim — an IdP
  group literally named `owner` would grant the `owner` role. Production boot now
  refuses OIDC without an explicit role map (dev warns). Set e.g.
  `OIDC_ROLE_MAP={"platform-admins":"owner"}`.

### Security

- **Control-plane tenant isolation for unbound operators.** An unbound operator
  without `tenant:switch` (e.g. an OIDC `key-admin`/`finops` with no
  `OIDC_TENANT_CLAIM`) could omit the `X-Modelgov-Tenant` header to reach *every*
  tenant's API keys, audit trail, emergency switch, and tenant list on the
  control plane — including rotating another tenant's key to obtain a live
  secret. Such operators are now confined to the default partition exactly like
  the data plane; only a `tenant:switch` platform operator sees all tenants.
  Audit-chain verification (`/v1/admin/audit/verify`) now also requires
  `tenant:switch`.
- **Embeddings honor a chat-oriented `pii_scope: output` safely.** A
  `pii_scope: output` config (mask completions only) silently disabled *all* PII
  masking for `POST /v1/embeddings` (embeddings have no output side), sending raw
  PII to the provider/vector store. Embeddings now always run input-side PII
  handling regardless of scope.
- **Safety/data-class config keys are validated strictly.** A misspelled key
  under `safety.protect`, `features.*.safety`, or `data_classes.*` (e.g.
  `promptInjection` in camelCase, or `allowed_providrs`) was silently dropped and
  could fail *open* (injection off, or restricted data routed to any provider).
  Such keys are now a loud config error, matching the budget schemas.
- **Injection classifier respects data-sovereignty.** A `prompt_injection: block`
  feature with a restricted `data_sensitivity` class is now rejected at config
  load if `safety.injection_model` routes to a provider outside that class's
  `allowed_providers` — previously the classifier could exfiltrate restricted
  text to an unapproved provider before any block decision.
- **Block-mode safety fails closed on unscanned images.** A `pii: block` or
  `prompt_injection: block` feature now rejects a message carrying an image part
  (images aren't scanned) instead of forwarding it unscanned.
- **Two-person policy approval keys on a stable identity.** The self-approval
  check now compares the OIDC `sub` / API-key id rather than the mutable display
  name.

### Fixed

- **Stripe subscription webhooks are ordered.** A late-redelivered
  `customer.subscription.updated` (`active`) arriving after a `deleted` no longer
  re-upgrades a cancelled account; events older than the last applied one (by
  Stripe `event.created`) are skipped. Adds migration `0027`.
- **Checkout credits wait for cleared funds.** `checkout.session.completed` with
  `payment_status: "unpaid"` (async ACH/SEPA/boleto) no longer grants credits;
  the grant defers to `checkout.session.async_payment_succeeded`.
- **Admin top-up idempotency keys are namespaced** by tenant + user, so reusing a
  key across different grants no longer silently drops the second.
- **One billing account per Stripe customer** is enforced (migration `0027`,
  applied only when existing data is already clean) and customer lookups are
  deterministic.
- **Streamed requests deplete token caps.** When the provider omits the usage
  chunk, streamed settlement now estimates tokens from emitted characters instead
  of booking zero (token-only caps were previously evadable via streaming).
- **SDKs surface mid-stream errors.** Both the TypeScript and Python SDKs now
  raise on a mid-stream `event: error` frame instead of ending the stream
  silently (a truncated answer previously looked complete). An oversized
  `Idempotency-Key` is now a `400` rather than silently ignored, and
  `inputTokensEstimate` is bounded to avoid a numeric overflow.
- **CI/release test gate.** The `pnpm test … | tee` steps ran under GitHub's
  default shell (no `pipefail`), so a failing suite took `tee`'s exit code and
  passed CI *and* the release gate; all workflows now force `shell: bash`.
- **Streaming: client disconnect before the first token now aborts the upstream
  and releases the budget hold** (the disconnect handler was previously attached
  only after the first token, so a pre-first-byte disconnect drained the whole
  generation into a dead socket and settled for it). SSE writes now honor
  backpressure (`drain`) so a slow reader can't buffer the whole completion in
  memory.
- **LiteLLM client keeps its abort timeout armed until the response body is
  read** (chat + embeddings), so a provider that sends headers then stalls the
  body can't outlive the request/reservation waiting on the transport default.
- **Fallback budget top-up rolls back if the reservation lease was already swept**,
  instead of stranding `reserved_usd` with no lease behind it.

## [1.2.0] - 2026-07-07

### ⚠ Breaking
- **Tenant switching now requires the `tenant:switch` permission.** Previously any
  unbound (platform) principal could scope a request to any tenant via the
  `X-Modelgov-Tenant` header — including an OIDC-authenticated operator, which is
  always unbound, so a tenant-scoped IdP user could read/write other tenants'
  data. Switching now requires the new `tenant:switch` permission (granted to the
  `owner` role only by default). A static platform key that switches tenants must
  add `"tenant:switch"` to its permissions; OIDC operators can instead be bound to
  a tenant with the new `OIDC_TENANT_CLAIM`. Tenant-bound keys are unaffected
  (they already ignore the header).

### Security
- **Embeddings now enforce input PII masking/blocking.** `POST /v1/embeddings`
  previously shipped the raw caller text to the provider (and typically into a
  vector store) regardless of the feature's PII plan — chat masked/blocked but
  embeddings didn't. Input PII is now masked or blocked before the provider call
  with the same fail-closed semantics as chat (`503` on a safety-backend outage);
  the injection classifier is not run (embedding input is data, not instructions).
- **OIDC operators can be tenant-scoped** via `OIDC_TENANT_CLAIM`: when the token
  carries that claim the operator is bound to that tenant and cannot switch.
- **`env/VAR` in a policy is restricted to provider credentials.** A stored/file
  policy's provider `api_key: env/VAR` now only resolves vars ending in `_KEY`
  (plus any in `MODELGOV_POLICY_ENV_ALLOWLIST`); gateway secrets (`DATABASE_URL`,
  `STRIPE_SECRET_KEY`, `LITELLM_MASTER_KEY`, ...) are always denied, closing a
  latent exfiltration channel for a `policy:write` operator.
- **`GET /v1/admin/audit/verify` is restricted to platform operators.** The audit
  hash chain spans all tenants, so its result (row count, tamper-point id) leaked
  cross-tenant metadata to a tenant-bound admin; tenant-bound callers now get 403
  (tenant-scoped reads still use `GET /v1/admin/audit`).
- **Chat/explain permission checks are unconditional** (no longer skipped for a
  principal without a name — defense against a fail-open edge).

### Fixed
- **Repinned the LiteLLM image to a tag that exists.**
  `ghcr.io/berriai/litellm:main-v1.55.10-stable` was removed upstream and no
  longer resolves, so `./setup` (`docker-compose.simple.yml`) and the Helm
  default (`deploy/helm/modelgov/values.yaml`) both failed at image pull. Both
  now pin `main-v1.72.0-stable`.
- **`./setup` smoke test no longer false-positives on the demo reply.** The
  bundled demo provider's canned response contained the word "Modelgov", which
  Presidio's spaCy recognizer classifies as a `LOCATION` entity, so the `strict`
  `support_chat` smoke was blocked by output-PII detection (`403`) on a clean
  install. The demo reply no longer contains a PII-triggering token.
- **`modelgov doctor production` reads the env file relative to the invocation
  directory.** It resolved `.env.production` against the CLI's own install path,
  so an installed/`npx` CLI read `node_modules/.env.production` (i.e. nothing) and
  reported a bogus production posture. It now uses the invocation cwd
  (`resolveUserPath`) like every other command.
- **`docker-compose.production.yml` now boots as documented.** Previously the
  shipped `.env.production.example` defaulted `DATABASE_SSL=require` while the
  bundled `postgres` service ships with TLS off (crash-loop at connect), the
  compose injected an empty `METRICS_AUTH_TOKEN` that the env validator rejected,
  and the SSL/metrics escape-hatch vars weren't in the compose `environment:`
  allowlist so setting them did nothing. The example now defaults to
  `DATABASE_SSL=disable` + `DATABASE_SSL_DISABLE_ALLOWED=true` for the bundled
  stack (managed Postgres still uses `verify-full`), empty `METRICS_AUTH_TOKEN`
  is treated as unset, and the compose passes the escape-hatch vars through.
- **Compose env allowlist completed.** `docker-compose.production.yml` now
  forwards every documented optional var — including the dynamic-policy features
  (`POLICY_STORE_ENABLED`, `POLICY_HOT_RELOAD`, `POLICY_APPROVAL_REQUIRED`,
  `MULTI_TENANT_POLICY`, `POLICY_CACHE_TTL_MS`), OIDC (`OIDC_*`),
  `HIERARCHICAL_BUDGETS`, `DB_RLS_ENABLED`, `ALLOW_BOOTSTRAP_ADMIN_KEY`,
  `MODELGOV_BEHIND_PROXY`, OTEL export, and the DB timeouts — so enabling them in
  `.env.production` is no longer a silent no-op.
- **`make up-prod` no longer reports success when the stack failed.** The launcher
  now detects a crash-looping/exited api container, prints its logs, and exits
  non-zero instead of printing `✓` after the wait loop times out.

### Changed
- **Published Docker images are `linux/amd64` only** (documented in
  `docs/production-deploy.md`). arm64 hosts (Graviton, Apple Silicon) should build
  the image natively (`BUILD_LOCAL_IMAGE=true`) rather than pulling; a native
  multi-arch image is planned.

### ⚠ Breaking
- **`DATABASE_SSL=require` with a remote `DATABASE_URL` now refuses to boot in
  production.** `require` encrypts but does NOT verify the Postgres server
  certificate, so a managed/remote connection is MITM-able while reading as
  "secure TLS". Deployments that explicitly set `DATABASE_SSL=require` against a
  non-local host must switch to `DATABASE_SSL=verify-full` (set `DATABASE_SSL_CA`
  if the CA isn't in the system trust store) — or, only for a trusted private
  network, set `DATABASE_SSL_NO_VERIFY_ALLOWED=true` to keep the old behavior.
  `modelgov doctor production` flags this before you deploy.

### Added
- **Platform tenant switching**: a platform (non-tenant-bound) operator can scope
  any request to one tenant via the `X-Modelgov-Tenant` header — it sets the
  effective `ctx.tenantId`, so every tenant-scoped read/write (usage, requests,
  audit, policy) targets that tenant. A tenant-**bound** key ignores the header
  (locked to its own tenant — no cross-tenant escape). New `GET /v1/admin/tenants`
  lists selectable tenants (platform sees all; a bound key sees only its own),
  `GET /v1/admin/whoami` now returns `tenantBound`, and the operator console gains
  a **tenant switcher** that re-scopes every page. `GET /v1/usage`'s
  `globalMonthly.capUsd` now follows the effective tenant's active policy (and
  hot-reloaded versions) instead of the static boot cap.
- **Env interpolation for the policy store**: configs loaded from the versioned
  store now resolve `env/VAR` provider-key references (boot load and per-request
  resolver), matching the file path — a stored version can reference a secret via
  `providers.<name>.api_key: env/OPENAI_KEY` without baking it into the database.
  Resolution runs only on the serving path, never on diff/preview (which must not
  expose resolved secrets).
- **Operator console Metrics page**: scrapes Prometheus `/metrics` (with an
  optional `METRICS_AUTH_TOKEN`) and renders the deployment-wide `modelgov_*`
  domain counters (requests, cost, fallbacks, budget/safety blocks) and gauges —
  a dependency-free text-format parser, no chart library.
- **Zero-restart policy hot reload** (default on when `POLICY_STORE_ENABLED=true`,
  toggle `POLICY_HOT_RELOAD`): activating a version applies without a restart —
  each request resolves the active version through a short-TTL cache, and
  activation fires a transactional Postgres `NOTIFY modelgov_policy_activated`
  that every replica LISTENs on to invalidate its cache instantly (TTL is the
  backstop if a notification is missed). Previously a single-tenant deployment
  applied an activated version only on the next rolling restart. The listener is
  a dedicated connection that reconnects with backoff, so an outage degrades to
  TTL-bounded convergence rather than a failed boot or request.
- **Two-person approval for policy changes** (opt-in, `POLICY_APPROVAL_REQUIRED`):
  a saved version is `proposed` and can only be activated after a **different**
  operator holding the new `policy:approve` permission approves it
  (`POST /v1/admin/policy/versions/:id/approve`); self-approval is rejected
  (`403 self_approval`) and activating an unapproved version returns
  `409 not_approved`. Adds a `policy-approver` role (kept distinct from
  `policy-admin`, which authors but cannot approve), a `/reject` endpoint, and
  `policy.approve` / `policy.reject` audit actions. Migration `0025` adds the
  `status` state machine (`proposed`/`approved`/`rejected`) plus `proposed_by` /
  `reviewed_by`; existing rows backfill to `approved`, so with the flag off the
  save→activate flow is unchanged.
- **Operator console v1** (`apps/operator-console`): the Policy page is now a full
  editor — validate + diff a proposed YAML against the active version, save,
  approve/reject (two-person rule), and activate/rollback with a version-history
  table showing status, proposer, and reviewer. Adds an Audit page (action log +
  hash-chain verify) and a Privacy/DSAR erasure page, and the nav plus per-row
  actions are permission-aware via the new `GET /v1/admin/whoami`. The Overview
  is now a **live dashboard** — it polls `usage/summary` + `usage` every 15s
  (live/pause toggle, 24h/7d/30d window) and renders a global spend-vs-cap gauge
  and a request-outcome bar chart with dependency-free CSS bars.
- **`GET /v1/usage` now returns `globalMonthly.capUsd`**: the configured global
  monthly cap, so the console can render spend-vs-cap without fetching policy.
- **`metered` billing mode**: bill usage through a Stripe Billing Meter instead
  of (not alongside) prepaid credits. Requires `billing.provider: stripe` and
  `billing.stripe.meter_event_name`; the maintenance loop reports settled usage
  to the meter (idempotent per request id). Prepaid credits and the meter remain
  mutually exclusive per deployment — config validation rejects combining them,
  and now also rejects a `meter_event_name` in `internal_only` mode (it would
  silently never report).
- **`/v1/embeddings` now enforces billing**: prepaid-credit check/reserve/settle
  (402 `insufficient_credits` on an empty wallet, fallback top-ups included) and
  meter reporting in `metered` mode. Previously embeddings bypassed billing
  entirely — real provider spend with no wallet debit.
- **Wallet reconciliation sweep** (migration `0024`): credit reservations are
  now backed by per-request leases; a crash or failed settle between reserve and
  settle no longer strands `credits_reserved_usd` forever — the maintenance
  sweep returns stale holds to the wallet within `RESERVATION_STALE_MS`, and
  settles are idempotent under retry (never double-charged).
- **Tenant-scoped emergency pause**: a tenant-bound `policy:write` key now
  pauses only its own tenant; only a platform (non-tenant-bound) key pauses
  every tenant. Previously any tenant admin could halt all tenants.
- **Retention sweeps** for billing/outbox plumbing tables: delivered webhooks
  (30d), dead-lettered webhooks (90d), reported meter events (30d),
  never-reportable meter events (90d, logged as a warning — that usage was not
  invoiced), and Stripe webhook idempotency records (90d).
- `billing.stripe.downgrade_user_type`: the user type applied on
  `invoice.payment_failed` (default `free_user`).
- Operator console: CSP + security headers on the nginx image, an https warning
  when the login URL would send the token to a remote host over plain http,
  surfaced revoke-key failures, and first unit tests (wired into `test:packages`
  and lint).
- Deploy wiring for billing: `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
  (+ `MODELGOV_DEPLOY_PROFILE`) pass through `docker-compose.production.yml`,
  and the Helm chart gained `secret.stripeSecretKey` / `secret.stripeWebhookSecret`.
- Docs: `billing:` reference in `docs/configuration.md`, all post-1.0 routes in
  `docs/api.md`, a compose-stack matrix in `docs/operations.md`, and the full
  examples list in the README.

### Fixed
- Stripe webhook signature verification now accepts any matching `v1=` entry,
  so events signed during a webhook-secret rotation are no longer dropped.
- SSRF host guard now catches numeric IPv4 encodings (`http://2130706433/`,
  hex/octal, short forms), IPv4-mapped IPv6, CGNAT (100.64/10) and 0/8 ranges,
  and bracketed IPv6 hosts (`[::1]` was previously not matched at the delivery
  sink).
- The committed OpenAPI spec now includes `/v1/webhooks/stripe` (the export
  previously ran with billing disabled, dropping the conditionally-registered
  route).

### Changed
- Release workflow now runs the full test suite (with Postgres) on the tagged
  commit before publishing to npm/PyPI, and all third-party GitHub Actions are
  pinned to commit SHAs. CI runs once per ref (concurrency groups; push builds
  restricted to `main` and tags) and uploads the coverage report as an artifact.
- k8s manifests and README now use the real GHCR image path shape
  (`ghcr.io/mml555/modelgov/modelgov-api`).
- The dev `docker-compose.local.yml` overlay binds the API to 127.0.0.1 (it
  runs with the well-known local key).
- Vitest upgraded 2.1 → 4.1. Coverage thresholds were re-baselined for the new
  v8 provider's counting AND the newly-measured CLI package, with per-package
  threshold gates added (api / policy-engine / sdk-typescript / cli) so the
  global number can't hide a single package's regression. CI's "integration
  tests actually ran" guard was updated for vitest 4's summary format (the old
  per-file `↓` markers are gone — the previous grep would have silently never
  fired again).

## [1.1.0] - 2026-07-03

### Added
- **Stripe billing (optional)**: a credit-wallet billing mode with `credits_only`
  and hybrid (`min(internal budget, credits)`) settlement. In `credits_only`
  mode the chat pipeline skips the internal budget ledger and settles spend via
  Stripe credits + meter reporting. Off unless configured.
- **Emergency pause**: a global kill-switch that blocks AI requests.
- **Durable webhook outbox** (migration `0023`): reliable, retried webhook
  delivery. Budget alerts now enqueue to the outbox and the maintenance sweep
  delivers them; the Stripe meter flush runs in the same sweep when billing is
  enabled.

### Changed
- Idempotency helper generalised to `IdempotentOutcome<T | ChatFailure>` so it
  can wrap responses beyond chat.

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
- **Project renamed `ai-guard` → `modelgov`** across every surface. Migration for
  pre-1.0 users:
  - **npm packages:** `@ai-guard/*` → `@modelgov/*` (`@modelgov/sdk`,
    `@modelgov/api`, `@modelgov/cli`, `@modelgov/policy-engine`); scaffolder
    `create-ai-guard` → `create-modelgov`.
  - **PyPI:** the Python SDK is now published as `modelgov`.
  - **CLI:** the `ai-guard` command is now `modelgov`.
  - **Config file:** `ai-guard.yaml` → `modelgov.yaml`.
  - **Env vars:** `AI_GUARD_*` → `MODELGOV_*` (e.g. `AI_GUARD_API_KEY(S)` →
    `MODELGOV_API_KEY(S)`, `AI_GUARD_CONFIG` → `MODELGOV_CONFIG`,
    `AI_GUARD_PRODUCTION` → `MODELGOV_PRODUCTION`). The old names are **not**
    read — update your environment before upgrading.
  - **Container image:** `ghcr.io/<org>/ai-guard-api` → `ghcr.io/<org>/modelgov-api`.
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

[Unreleased]: https://github.com/mml555/modelgov/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/mml555/modelgov/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/mml555/modelgov/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/mml555/modelgov/releases/tag/v1.0.0
[0.6.0]: https://github.com/mml555/modelgov/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mml555/modelgov/compare/v0.0.0...v0.5.0
[0.0.0]: https://github.com/mml555/modelgov/releases/tag/v0.0.0
