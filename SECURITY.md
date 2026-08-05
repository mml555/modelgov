# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.2.x | Yes |
| 1.1.x | Yes |
| 1.0.x | Yes |

## Reporting a vulnerability

**Do not** open public GitHub issues for security vulnerabilities.

Report security issues privately:

1. **GitHub (preferred):** open a [private security advisory](https://github.com/mml555/modelgov/security/advisories/new) on this repository.
2. **Email:** `security@modelgov.dev` (PGP key available on request).

Include:

- Description and impact
- Steps to reproduce
- Affected version / commit
- Suggested fix (optional)

We aim to acknowledge within 72 hours and provide a remediation timeline for
confirmed issues.

## Security model

Modelgov is a **self-hosted** control plane. You are responsible for:

- Network exposure and TLS
- API key generation, rotation, and storage
- Postgres access control and encryption at rest
- Provider API key handling (via LiteLLM)

Modelgov enforces **AI policy** (budgets, safety, routing). It does **not**
replace application authentication or authorization.

## Hardening recommendations

- Seed one bootstrap `keys:admin` key via `MODELGOV_API_KEYS`; issue all other keys from the DB-backed key store so they can be rotated/revoked without a redeploy (only key hashes are stored, never plaintext)
- Use scoped keys with minimal `permissions`, and set `expiresAt` for short-lived keys
- Never commit `.env` or production secrets — mount them from a secrets manager using the `*_FILE` convention (e.g. `DATABASE_URL_FILE=/run/secrets/db_url`), which integrates with Vault Agent, the AWS/GCP/Azure Secrets Store CSI drivers, Kubernetes Secrets, and Docker secrets
- Place the API behind a reverse proxy with TLS
- Restrict Postgres to private networks
- Pin container images in production
- Set `OBSERVABILITY_CAPTURE_CONTENT=false` unless required
- Set `IDEMPOTENCY_CAPTURE_CONTENT=false` unless you need completion text on idempotency replays
- Set `METRICS_AUTH_TOKEN` when `/metrics` is reachable beyond an internal scrape network (required when `MODELGOV_PRODUCTION=true` and `METRICS_ENABLED=true`)
- Tenant-bound API keys scope `/v1/usage`, `/v1/requests`, and `/v1/admin/erasure` to their tenant — issue separate keys per tenant for DPO workflows
- Review Presidio and Langfuse deployment exposure

## Dependencies

Modelgov composes LiteLLM, Presidio, Postgres, and optionally Langfuse. Monitor
CVEs in those components and rebuild images on security patches.

CI gates every PR on `pnpm audit --prod --audit-level high`. A newly disclosed
advisory in a transitive dependency is fixed by pinning the patched version in
`pnpm-workspace.yaml` → `overrides`, **not** by relaxing the gate. Those pins go
stale: `postcss` was once pinned for an advisory and later became the vulnerable
version itself, so raise them rather than assuming a pin is still safe.

### Accepted advisories

`pnpm-workspace.yaml` → `auditConfig.ignoreGhsas` suppresses specific
advisories, each with its justification inline and tabulated here. An entry is
only acceptable when the vulnerable code path is **provably unreachable** in
this project — never merely inconvenient to fix. (The key is `ignoreGhsas`;
`ignoreCves` takes CVE ids and silently does nothing for a GHSA id.)

| Advisory | Package | Why it does not apply |
| --- | --- | --- |
| [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2) | `react-router` (via `react-router-dom` in the operator console) | CSRF in **RSC mode**. The advisory states it "only affects your application if you are using the unstable RSC APIs". The console is a static Vite SPA served by nginx (`apps/operator-console/Dockerfile`) whose only router import is `react-router-dom` — no RSC, no server runtime, no router actions. The fix is `react-router` 8.x, a major bump under our `react-router-dom ^7`. Revisit when the console upgrades. |
