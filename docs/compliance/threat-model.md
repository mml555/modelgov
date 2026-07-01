# Threat model (STRIDE)

A STRIDE-style threat model for a self-hosted Ai-Guard deployment. It identifies
trust boundaries, assets, and per-category threats, and maps each threat to the
**mitigations that ship today** versus **residual risk the operator must own**.

Ai-Guard is a self-hosted control plane: you own network exposure, TLS, Postgres
access control, and provider-key handling (see [SECURITY.md](../../SECURITY.md)).
This model assumes the [production checklist](../operations.md#production-checklist)
and [hardening recommendations](../../SECURITY.md#hardening-recommendations) are
followed; where they are not, threats that they mitigate become residual.

---

## System & trust boundaries

```text
┌─────────────────────────────────────────────────────────────────────┐
│ TB1: Internet / caller network                                       │
│   Application (owns user auth + product RBAC)                        │
└───────────────┬─────────────────────────────────────────────────────┘
                │ HTTPS + Authorization: Bearer <API key>   ── TB2 ──►
┌───────────────▼─────────────────────────────────────────────────────┐
│ TB3: Ai-Guard trust zone (private network)                           │
│                                                                      │
│  Ai-Guard API ── policy engine (pure) ── budget reserve (Postgres)   │
│      │                                                               │
│      ├── Presidio (PII / injection)                                  │
│      ├── Postgres (budgets, audit, api_keys, idempotency)            │
│      ├── Redis (rate-limit counters)                                 │
│      └── LiteLLM ──TB4──► provider (OpenAI/Anthropic/…) over TB1     │
│                                                                      │
│  Operator / automation ──TB5──► control plane (/v1/admin/*, usage)   │
│    via API key (keys:admin) OR OIDC JWT → operator role → perms      │
└──────────────────────────────────────────────────────────────────────┘
```

| Boundary | Between | Crossing control |
| --- | --- | --- |
| **TB1** | Internet ↔ your edge | TLS at LB/proxy (no built-in TLS); `TRUST_PROXY` for real client IPs |
| **TB2** | Application ↔ Ai-Guard API | Bearer API key; per-key permissions + scope (`projectId`, `allowedUserTypes/Ids`) |
| **TB3** | Ai-Guard API ↔ its backends | Private network only; Postgres/Redis/Presidio not internet-exposed |
| **TB4** | LiteLLM ↔ upstream provider | Provider API keys (held by LiteLLM), `LITELLM_MASTER_KEY` between API and LiteLLM |
| **TB5** | Operator/automation ↔ control plane | `keys:admin` API key **or** OIDC JWT → operator RBAC role → permissions |

---

## Assets

| Asset | Why it matters | Store |
| --- | --- | --- |
| **Budget state** (`budget_counters`) | Corruption/bypass → uncontrolled spend | Postgres |
| **Audit log** (`request_logs`) | Integrity = compliance evidence; metadata only | Postgres |
| **API keys** (`api_keys`) | Compromise → impersonate callers | Postgres (SHA-256 hashes only) |
| **Prompt / completion content** | Sensitive user data; PII | **Transient by default** — not stored in `request_logs`; only in Langfuse/idempotency if content capture explicitly enabled |
| **Provider API keys** | High-value; direct provider spend | LiteLLM env / secrets manager |
| **`LITELLM_MASTER_KEY`** | Auth between API and LiteLLM | Secrets manager |
| **Operator credentials** (OIDC / keys:admin) | Control-plane takeover | IdP / secrets manager |

---

## Threats & mitigations (STRIDE)

### S — Spoofing (identity)

| Threat | Mitigation (shipped) | Residual |
| --- | --- | --- |
| Caller forges another app's identity to spend its budget | Per-key bearer auth; scoped keys pin `projectId` and can restrict `allowedUserTypes` / `allowedUserIds` | App is responsible for authenticating the end user; Ai-Guard trusts the `userId`/`userType` the key is allowed to send |
| Operator impersonation on control plane | OIDC JWT verified against IdP JWKS (signature, `iss`, `aud`, `exp`); or `keys:admin` bearer | Strength of IdP + `OIDC_AUDIENCE` config; a verified token with no mapped role gets **403**, not access |
| Client IP spoofing to dodge rate limits | `TRUST_PROXY` set to the proxy CIDR so `X-Forwarded-For` can't be spoofed | Must be configured; unset `TRUST_PROXY` = spoofable buckets |
| Fake upstream provider (MITM to LiteLLM) | Providers over TLS; LiteLLM in private zone | Operator must keep provider egress TLS-verified |

### T — Tampering (integrity)

| Threat | Mitigation (shipped) | Residual |
| --- | --- | --- |
| Tamper with budget counters to over-spend | Atomic reservations under row locks; counters only mutated by the API | Direct Postgres write access bypasses this — restrict DB to private network + least-privilege roles |
| Alter/delete audit records | **Hash-chained admin audit log** (`admin_audit_log`): each row's SHA-256 over the prior row's hash; `GET /v1/admin/audit/verify` re-walks the chain and detects any altered/deleted/inserted row | Detection (not prevention) — pair with WORM/SIEM export + immutable DB backups; the request-audit `request_logs` table is not yet chained |
| Modify policy (`ai-guard.yaml`) to widen limits | Config is operator-controlled; `policy-admin` role gates policy writes; `ai-guard validate --production` | File/ConfigMap write access = policy control — protect via GitOps + RBAC on the deploy pipeline |
| Tamper with budget-alert webhook payload | Optional `X-Ai-Guard-Signature` HMAC (`BUDGET_ALERT_WEBHOOK_SECRET`) | Only if secret is set |
| Container/image tampering | CI publishes **SBOM + provenance attestations**; Trivy scan; no floating `:latest` (pin by digest) | Operator must actually pin digests and verify attestations |

### R — Repudiation (non-repudiation)

| Threat | Mitigation (shipped) | Residual |
| --- | --- | --- |
| Caller denies making a request | Every request logged to `request_logs` with decision, cost, `userId`, `userType`, `feature`, `requestId`; correlation IDs returned in responses/headers | Metadata only (no content) unless Langfuse capture enabled; log integrity depends on DB controls |
| Operator denies an admin action | Privileged mutations (key create/rotate/revoke, policy save/activate, data erasure) are written to the hash-chained `admin_audit_log` with actor (API-key name or OIDC `sub`), action, target, and timestamp | Detection via chain verify; export to WORM/SIEM for long-term retention |

### I — Information disclosure (confidentiality)

| Threat | Mitigation (shipped) | Residual |
| --- | --- | --- |
| PII in prompts leaks to provider/logs | Presidio PII **mask/block** per safety preset; **fails closed** (`503`) when Presidio is down | Coverage is Presidio's recognizer set; `dev` preset = no PII enforcement (operator choice) |
| Prompts/completions persisted where they shouldn't be | Content **not stored** in `request_logs`; `OBSERVABILITY_CAPTURE_CONTENT=false` and `IDEMPOTENCY_CAPTURE_CONTENT=false` by **default** | If an operator enables capture, that store holds sensitive content and must be protected/retained accordingly |
| API-key theft from the datastore | Only **SHA-256 hashes** stored; plaintext returned once at create/rotate and never retrievable | Plaintext must be handled safely by the issuer at creation time |
| Provider keys exposed | Held by LiteLLM in private zone; kept in secrets manager, not git | Operator must not commit `.env`; restrict LiteLLM exposure |
| `/metrics` scraped by outsiders | Off public LB by default; `METRICS_AUTH_TOKEN` requires bearer to scrape | Unauthenticated if reachable and no token set |
| Cross-tenant data read | Scoped keys hide global counters and read only their `projectId` partition; usage queries tenant-scoped | Ops keys (no `projectId`) intentionally see all — issue them narrowly |
| TLS not terminated → plaintext on the wire | Documented requirement to terminate TLS at LB/proxy | **No built-in TLS** — fully operator's responsibility (residual if skipped) |

### D — Denial of service (availability)

| Threat | Mitigation (shipped) | Residual |
| --- | --- | --- |
| Request flood exhausts the API | Per-IP rate limiting (`RATE_LIMIT_MAX`, default 120/min); Redis-shared across replicas; **fails closed** by default on limiter error | Tune limits; `RATE_LIMIT_FAIL_OPEN=true` trades safety for availability |
| Oversized request bodies | `REQUEST_BODY_LIMIT_BYTES` (default 1 MiB) | Operator can raise it |
| Global budget counter hot-row contention at high RPS | Per-transaction `lock_timeout` → fail-fast rather than pile-up | Throughput ceiling on the single global row (documented); shard if outgrown |
| Slow/hung provider ties up workers | `LITELLM_TIMEOUT_MS` / `REQUEST_TIMEOUT_MS` (default 60s); fallback model on provider failure | No streaming in v1 → long completions hold a worker for their full duration |
| Backend dependency outage | Fail-closed on policy/safety (no unguarded calls); graceful degrade on Langfuse | Availability depends on operator HA (see [high-availability](../deployment/high-availability.md)) |
| Budget exhaustion as financial DoS | Atomic caps (user/feature/global) block spend at the limit | Caps are the guard; set them deliberately |

### E — Elevation of privilege

| Threat | Mitigation (shipped) | Residual |
| --- | --- | --- |
| Low-scope key performs admin actions | Per-permission checks; `keys:admin` required for all `/v1/admin/keys/*`; default keys carry only `chat:create` | Correct permission scoping is the operator's job at issuance |
| OIDC user gains more than intended | Least-privilege built-in roles (`viewer`/`finops`/`key-admin`/`policy-admin`/`owner`); IdP-group→role map; unmapped token → 403 | Depends on `OIDC_ROLE_MAP` accuracy and IdP group hygiene |
| Caller uses Ai-Guard to authorize a product action | Architectural boundary: Ai-Guard enforces **AI policy only**, never product authorization | App **must** run its own RBAC first — misuse is an integration error, not something Ai-Guard can prevent |
| Revoked/rotated key still accepted briefly | Rotate/revoke effective immediately on the handling replica; across the fleet within `API_KEY_CACHE_TTL_MS` (default 10s) | Up to the cache TTL window on other replicas — lower TTL if intolerable |

---

## Residual risk register

Risks that remain the operator's responsibility even with all shipped mitigations:

| # | Residual risk | Owner action |
| --- | --- | --- |
| R1 | No built-in TLS | Terminate TLS at LB/proxy; enforce HTTPS end to end |
| R2 | Direct Postgres write access bypasses budget/audit integrity | Private network, least-privilege DB roles, no broad write grants |
| R3 | Hash-chained audit gives *detection*, not prevention; `request_logs` isn't chained | Export `admin_audit_log` to WORM/SIEM; run `/v1/admin/audit/verify` on a schedule; immutable DB backups |
| R4 | Audit covers admin mutations; app-level events depend on host logging | Centralize API logs; alert on `keys:admin` / `policy:write` / `data:erase` use |
| R5 | Content capture, if enabled, creates a sensitive-data store | Keep defaults off; if on, protect + set retention (see [data-flow](./data-flow.md)) |
| R6 | Safety coverage bounded by Presidio recognizers; `dev` preset disables it | Use `balanced`/`strict` in production; extend recognizers as needed |
| R7 | Global-counter throughput ceiling | Monitor contention; shard the counter at scale |
| R8 | Key-cache TTL window for revocation propagation | Lower `API_KEY_CACHE_TTL_MS` if the 10s default is unacceptable |
| R9 | Ai-Guard does not authenticate end users | App must run auth + product RBAC before calling |

See [SOC 2 control mapping](./soc2-controls.md), [data-flow & DLP](./data-flow.md),
and [failure semantics](../failure-semantics.md).
