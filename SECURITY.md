# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.0.0 | Yes (pre-release baseline; active development) |

## Reporting a vulnerability

**Do not** open public GitHub issues for security vulnerabilities.

Report security issues privately:

1. **GitHub (preferred):** open a [private security advisory](https://github.com/mml555/Ai-Guard/security/advisories/new) on this repository.
2. **Email:** `security@ai-guard.dev` (PGP key available on request).

Include:

- Description and impact
- Steps to reproduce
- Affected version / commit
- Suggested fix (optional)

We aim to acknowledge within 72 hours and provide a remediation timeline for
confirmed issues.

## Security model

Ai-Guard is a **self-hosted** control plane. You are responsible for:

- Network exposure and TLS
- API key generation, rotation, and storage
- Postgres access control and encryption at rest
- Provider API key handling (via LiteLLM)

Ai-Guard enforces **AI policy** (budgets, safety, routing). It does **not**
replace application authentication or authorization.

## Hardening recommendations

- Seed one bootstrap `keys:admin` key via `AI_GUARD_API_KEYS`; issue all other keys from the DB-backed key store so they can be rotated/revoked without a redeploy (only key hashes are stored, never plaintext)
- Use scoped keys with minimal `permissions`, and set `expiresAt` for short-lived keys
- Never commit `.env` or production secrets — mount them from a secrets manager using the `*_FILE` convention (e.g. `DATABASE_URL_FILE=/run/secrets/db_url`), which integrates with Vault Agent, the AWS/GCP/Azure Secrets Store CSI drivers, Kubernetes Secrets, and Docker secrets
- Place the API behind a reverse proxy with TLS
- Restrict Postgres to private networks
- Pin container images in production
- Set `OBSERVABILITY_CAPTURE_CONTENT=false` unless required
- Set `IDEMPOTENCY_CAPTURE_CONTENT=false` unless you need completion text on idempotency replays
- Set `METRICS_AUTH_TOKEN` when `/metrics` is reachable beyond an internal scrape network (required when `AI_GUARD_PRODUCTION=true` and `METRICS_ENABLED=true`)
- Tenant-bound API keys scope `/v1/usage`, `/v1/requests`, and `/v1/admin/erasure` to their tenant — issue separate keys per tenant for DPO workflows
- Review Presidio and Langfuse deployment exposure

## Dependencies

Ai-Guard composes LiteLLM, Presidio, Postgres, and optionally Langfuse. Monitor
CVEs in those components and rebuild images on security patches.
