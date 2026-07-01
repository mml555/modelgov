# Vendor security questionnaire (pre-filled)

Pre-filled answers to a standard SIG/CAIQ-style vendor security review, grounded in
Ai-Guard's real architecture. Use this to accelerate procurement/security reviews.

> **Two kinds of answer.** Answers about the **software** (encryption support,
> access control, key management, logging, data handling) are factual and cite the
> source docs. Answers about the **operating environment** (where it's hosted, who
> is on-call, HR controls) depend on *your* deployment because Ai-Guard is
> **self-hosted** — those are marked **`[OPERATOR]`** and must be completed by the
> entity running it. Do not claim organizational certifications the operating
> entity does not hold.

**Product:** Ai-Guard — self-hosted AI policy gateway  ·  **Deployment model:**
customer-hosted (on your infrastructure/cloud)  ·  **License:** MIT

---

## A. Encryption

| # | Question | Answer |
| --- | --- | --- |
| A1 | Data in transit encrypted? | **Yes, operator-terminated.** Ai-Guard has **no built-in TLS**; TLS is terminated at a reverse proxy/LB in front of the API (documented requirement). DB connections support TLS via `DATABASE_SSL=verify-full` + `DATABASE_SSL_CA`. See [operations networking](../operations.md#networking--tls). `[OPERATOR must enforce.]` |
| A2 | Data at rest encrypted? | Relies on the underlying store: enable Postgres/volume encryption and encrypted backups. Ai-Guard stores only **SHA-256 hashes** of API-key secrets, never plaintext. `[OPERATOR enables storage encryption.]` |
| A3 | Key material / secrets encryption | Provider keys and `LITELLM_MASTER_KEY` held outside the codebase in the operator's secrets manager; never committed to git (hardening guidance in [SECURITY.md](../../SECURITY.md)). |
| A4 | Cryptographic standards | SHA-256 for API-key hashing. TLS cipher suite is the operator's LB configuration. |

## B. Access control & authentication

| # | Question | Answer |
| --- | --- | --- |
| B1 | How is application access authenticated? | Bearer API keys (`Authorization: Bearer`) on all routes except `/health` and `/ready`. See [API auth](../api.md). |
| B2 | Operator / admin authentication | Operator SSO via **OIDC**: JWT verified against the IdP JWKS (signature, `iss`, `aud`, `exp`), then group/role claim mapped to operator roles. Or a bootstrap `keys:admin` API key. See [operations OIDC & RBAC](../operations.md#operator-sso-oidc--rbac). |
| B3 | Role-based access control? | **Yes.** Per-key `permissions` (least privilege; default keys carry only `chat:create`). Built-in operator roles: `viewer`, `finops`, `key-admin`, `policy-admin`, `owner`. A verified OIDC token with no mapped role gets **403**, not access. |
| B4 | Multi-tenancy / data isolation | Scoped keys pin `projectId` and can restrict `allowedUserTypes` / `allowedUserIds`. Tenant keys read only their project's budget partition; global counters are hidden. See [configuration — scoped keys](../configuration.md#scoped-api-keys-multi-tenant-operators). |
| B5 | Least privilege enforced? | Yes — per-permission checks on every route; admin key routes require `keys:admin`. |
| B6 | MFA | Provided by your IdP for operator SSO. `[OPERATOR: enforce MFA in the IdP.]` |
| B7 | Session / token expiry | OIDC tokens expire per IdP (`exp` verified). API keys support `expiresAt` for short-lived keys. |

## C. Key & credential management

| # | Question | Answer |
| --- | --- | --- |
| C1 | How are API keys issued? | Via the DB-backed key store (`POST /v1/admin/keys`, `keys:admin`). Plaintext secret returned **once** at create; only the SHA-256 hash is stored. See [operations key management](../operations.md#api-key-management). |
| C2 | Rotation supported? | **Yes** — `POST /v1/admin/keys/:id/rotate` mints a new secret; the old one is rejected immediately. No redeploy required. |
| C3 | Revocation supported? | **Yes** — `POST /v1/admin/keys/:id/revoke` (idempotent). Effective immediately on the handling replica; across the fleet within `API_KEY_CACHE_TTL_MS` (default 10s). |
| C4 | Are secrets retrievable after creation? | **No.** Only the hash is stored; plaintext is never retrievable again. |
| C5 | Provider (LLM) key handling | Held by LiteLLM in the private zone, sourced from the operator's secrets manager. The pure policy engine never reads provider keys. |

## D. Logging, monitoring & audit

| # | Question | Answer |
| --- | --- | --- |
| D1 | Is activity logged? | **Yes.** Every request is written to `request_logs` with `userId`, `userType`, `feature`, decision, `reasonCode`, and cost. **Metadata only — prompts/completions are not stored.** See [API `/v1/requests`](../api.md#get-v1requests). |
| D2 | Audit trail access | `GET /v1/requests` / `/v1/requests/:id` (`requests:read`); correlation via `requestId` / `x-ai-guard-request-id`. |
| D3 | Metrics / monitoring | Prometheus `/metrics` (request rate/errors/latency, pg pool saturation, Node defaults). `/metrics` is internal-only by default; `METRICS_AUTH_TOKEN` adds bearer auth. See [operations metrics](../operations.md#metrics). |
| D4 | Log integrity / tamper-evidence | Admin mutations (key/policy/erasure) are written to a **hash-chained** `admin_audit_log`; `GET /v1/admin/audit/verify` re-walks the chain and detects any altered/deleted/inserted row. This is tamper-*detection*; export to a WORM/SIEM sink and use immutable backups for prevention/retention. |
| D5 | Alerting | Budget-alert webhook (optional HMAC-signed) on spend thresholds; operator sets metric-based alerts. See [budget alerts](../operations.md#budget-alerts). |
| D6 | Log retention | `request_logs` swept to `REQUEST_LOG_RETENTION_MS` (default 30 days). `[OPERATOR sets to policy.]` |

## E. Data handling & privacy

| # | Question | Answer |
| --- | --- | --- |
| E1 | What data is collected/stored? | Request **metadata** (identity, feature, decision, cost), budget counters, API-key hashes, short-lived idempotency records. **Prompt/completion content is transient by default.** See [data-flow](../compliance/data-flow.md). |
| E2 | Is prompt/response content stored? | **No, by default.** `OBSERVABILITY_CAPTURE_CONTENT` and `IDEMPOTENCY_CAPTURE_CONTENT` both default **off**. If an operator enables capture, that store must be protected/retained accordingly. |
| E3 | PII handling / DLP | **Presidio** PII mask/block and prompt-injection block per safety preset. **Fails closed** (`503`) when Presidio is unavailable — never sends unguarded. Coverage bounded by Presidio recognizers; `dev` preset disables enforcement. See [data-flow — PII](../compliance/data-flow.md#pii-handling-dlp-via-presidio). |
| E4 | Data retention & disposal | `request_logs` retention sweep (default 30d); idempotency/reservation leases auto-swept (15m). Content stores (if enabled) governed separately. |
| E5 | Data residency | Fully self-hosted — data resides where the operator deploys. The only external egress is to the chosen model provider; use a regional/self-hosted model (e.g. Bedrock in-region, Ollama) to keep content in-region. See [data-flow — residency](../compliance/data-flow.md#data-residency). `[OPERATOR states hosting region.]` |
| E6 | Data deletion / DSAR | **Right-to-erasure endpoint** `POST /v1/admin/erasure` (`data:erase`) deletes a user's request-linked data (`request_logs`, `idempotency_keys`) and is audited; plus global + per-feature retention sweeps. Consent management / full DSAR orchestration remain operator/DPA responsibility. |

## F. Incident response & vulnerability management

| # | Question | Answer |
| --- | --- | --- |
| F1 | Vulnerability disclosure process | Private reporting via GitHub Security Advisory or `security@ai-guard.dev`; acknowledgment target 72 h. See [SECURITY.md](../../SECURITY.md). |
| F2 | Vulnerability scanning | CI runs **Trivy** image scanning and publishes an **SBOM** + build **provenance attestations**; no floating `:latest` tag (pin by digest). |
| F3 | Incident response plan | [Incident-response runbook](../runbooks/incident-response.md): SEV1–4 classification, escalation, comms templates, post-mortems. `[OPERATOR operationalizes with on-call.]` |
| F4 | Patch management | Security patches on supported version lines; monitor CVEs in composed components (LiteLLM, Presidio, Postgres, Langfuse) and rebuild. See [versioning](../versioning.md). |
| F5 | Penetration testing | `[OPERATOR arranges pen testing of its deployment.]` |

## G. Availability & resilience

| # | Question | Answer |
| --- | --- | --- |
| G1 | High availability | Stateless API replicas, shared Redis rate limits, atomic Postgres budget reservations, `/health` + `/ready` probes. HA reference (multi-replica LiteLLM/Presidio, managed HA Postgres): [high-availability](../deployment/high-availability.md). No turnkey HA chart ships. |
| G2 | Backup & recovery | Stateless tiers redeploy from pinned images; Postgres restore. [DR runbook](../runbooks/disaster-recovery.md) with RTO/RPO targets and a tested-restore drill. No built-in backup scheduler — `[OPERATOR wires managed snapshots/PITR]`. |
| G3 | Fail-safe design | Fails **closed** on policy and safety (no unguarded/uncounted calls); degrades gracefully on observability. Rate limiting fails closed by default. See [failure semantics](../failure-semantics.md). |
| G4 | DoS protections | Per-IP rate limiting, request body limits, provider/request timeouts, atomic budget caps as financial DoS guard. |

## H. Compliance & certifications

| # | Question | Answer |
| --- | --- | --- |
| H1 | SOC 2 / ISO 27001? | Ai-Guard is **software, not a certified service** — SOC 2 certifies the operating **organization**, which is *you* (self-hosted). [SOC 2 control mapping](../compliance/soc2-controls.md) shows which technical criteria the gateway supports and the gaps. `[OPERATOR states its own certifications.]` |
| H2 | Threat model available? | **Yes** — [STRIDE threat model](../compliance/threat-model.md) with trust boundaries, mitigations, and a residual-risk register. |
| H3 | Secure SDLC | Versioned/pinned images, provenance attestations, SBOM, Trivy scans, advisory-locked migrations. `[OPERATOR: PR review/approvals/change management.]` |
| H4 | Subprocessors | See below — the primary subprocessor is *your* chosen model provider. |

---

## Subprocessors & data processing

Because Ai-Guard is self-hosted, the **operating entity is the data controller/
processor**; Ai-Guard the software introduces **no mandatory third-party
subprocessor**. Data leaves the operator's boundary only to the model provider the
operator configures.

| Subprocessor | Data shared | Purpose | Controlled by |
| --- | --- | --- | --- |
| Model provider (OpenAI / Anthropic / Gemini / Bedrock / self-hosted) | Prompt (post-masking) + completion content | Model inference | **Operator's** contract with that provider |
| Cloud/infra provider `[OPERATOR]` | All hosted data (encrypted per infra) | Hosting Postgres/Redis/LiteLLM/Presidio/API | Operator |
| Langfuse (optional) | Trace metadata; content only if capture enabled | Observability | Operator (self-hosted or SaaS choice) |

Ai-Guard does **not** phone home, does not transmit telemetry to the project, and
adds no analytics subprocessor.

## DPA & subprocessor outline

For a Data Processing Agreement between `[OPERATOR]` and its customer:

1. **Roles** — Customer is Controller; `[OPERATOR]` is Processor for data processed
   via its Ai-Guard deployment. Model providers are **sub-processors** engaged by
   the operator.
2. **Scope & purpose** — process prompt/response content solely to perform guarded
   inference and enforce the customer's AI policy; process metadata for audit,
   budgeting, and support.
3. **Data categories** — request metadata (identity, feature, decision, cost);
   optionally prompt/response content **only if** the operator enables capture.
   Highlight that content is transient by default.
4. **Sub-processor list & change notice** — enumerate the model provider(s) and
   infra provider; commit to `[X]` days' notice before adding/replacing a
   sub-processor.
5. **Security measures** — reference this questionnaire, the [threat model](../compliance/threat-model.md),
   and [SOC 2 mapping](../compliance/soc2-controls.md): encryption in transit/at
   rest, RBAC, key rotation/revocation, DLP (Presidio), audit logging, fail-closed
   design.
6. **Data residency** — state the hosting region(s) and the model-provider region;
   note the self-hosted / in-region model option for strict residency.
7. **Retention & deletion** — `request_logs` retention (default 30d, configurable);
   content-store retention if capture enabled; deletion on termination.
8. **Breach notification** — commit to notification within `[X]` hours of a
   confirmed breach, per the [incident-response runbook](../runbooks/incident-response.md).
9. **Data-subject rights** — process for assisting the Controller with access/
   deletion requests `[OPERATOR-defined]`.
10. **Audit rights** — customer's right to review this documentation and `[OPERATOR]`
    controls at `[agreed cadence]`.

*This outline is not legal advice; have counsel produce the executed DPA.*

Related: [threat model](../compliance/threat-model.md) ·
[SOC 2 controls](../compliance/soc2-controls.md) ·
[data-flow](../compliance/data-flow.md) · [SECURITY.md](../../SECURITY.md).
