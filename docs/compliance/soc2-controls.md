# SOC 2 Trust Services Criteria — control mapping

This maps Ai-Guard's shipped features to relevant SOC 2 Trust Services Criteria
(TSC) across **Security (Common Criteria)**, **Availability**, and
**Confidentiality**. It is a **product control mapping to support your audit** —
it is **not** a SOC 2 report and does **not** assert that Ai-Guard (the software
project) holds a SOC 2 certification.

> **Critical framing:** SOC 2 certifies an **organization's controls over a
> system**, not a piece of software. Because Ai-Guard is **self-hosted**, *your
> organization* is the entity that would be audited. Ai-Guard provides technical
> controls (below); the surrounding organizational controls — HR, change
> management, vendor management, physical security of your infra, monitoring —
> are **yours to implement and evidence**. Use this document to show auditors
> which technical criteria the gateway already helps satisfy and where you must
> add controls.

**Status legend:** **Implemented** (ships and enforced) · **Partial** (mechanism
exists but requires operator configuration or has gaps) · **Roadmap** (not built).

---

## Security — Common Criteria (CC)

### CC6 — Logical & physical access controls

| Criterion | Ai-Guard control | Status | Gap / operator action |
| --- | --- | --- | --- |
| CC6.1 Logical access — identification & auth | Bearer API keys per caller; OIDC JWT for operators verified against IdP JWKS (sig/iss/aud/exp) | **Implemented** | End-user auth is the app's; operator IdP config is yours |
| CC6.1 Credentials protected at rest | API-key secrets stored as **SHA-256 hashes only**; plaintext returned once, never retrievable | **Implemented** | — |
| CC6.2 Provision / de-provision access | DB key store: create/list/**rotate**/**revoke** via `/v1/admin/keys` (`keys:admin`); revoke effective ≤ `API_KEY_CACHE_TTL_MS` | **Implemented** | Establish an access-review cadence (org control) |
| CC6.3 Least privilege / RBAC | Per-key `permissions`; operator roles `viewer`/`finops`/`key-admin`/`policy-admin`/`owner`; unmapped OIDC token → 403 | **Implemented** | Correct scoping at issuance is operator's job |
| CC6.6 Boundary protection | Fail-closed rate limiting; `REQUEST_BODY_LIMIT_BYTES`; private-network backends; TLS at LB (documented) | **Partial** | **No built-in TLS** — operator terminates it; `TRUST_PROXY` must be set |
| CC6.7 Restrict data transmission | Documented TLS termination; `DATABASE_SSL=verify-full` for managed Postgres | **Partial** | Operator enforces TLS end to end |
| CC6.1 Encryption at rest | Relies on Postgres/volume/secrets-manager encryption | **Partial** | Operator enables DB + backup encryption |

### CC7 — System operations (monitoring, incident, change detection)

| Criterion | Ai-Guard control | Status | Gap / operator action |
| --- | --- | --- | --- |
| CC7.1 Detect vulnerabilities | CI runs **Trivy** image scanning; publishes **SBOM**; dependency monitoring guidance in SECURITY.md | **Implemented** (in CI) | Operator monitors CVEs on their pinned images |
| CC7.2 Monitor for anomalies | Prometheus `/metrics` (request rate/errors/latency, pg pool saturation); OpenTelemetry OTLP span export; budget-alert webhook; structured logs | **Implemented** | Operator wires alerting + SIEM |
| CC7.2 Audit trail integrity | Hash-chained `admin_audit_log` for key/policy/erasure mutations; `GET /v1/admin/audit/verify` detects tampering | **Implemented** | Export to WORM/SIEM; schedule chain verification |
| CC7.3 Evaluate security events | [Incident-response runbook](../runbooks/incident-response.md) (SEV classification, escalation, comms) | **Partial** (template) | Operationalize with your on-call |
| CC7.4 Respond to incidents | Vuln disclosure process (SECURITY.md); incident runbook | **Partial** | Adopt + drill |
| CC7.5 Recovery | [Disaster-recovery runbook](../runbooks/disaster-recovery.md); stateless tiers; Postgres restore | **Partial** | No built-in backup scheduler — operator wires managed snapshots/PITR |

### CC8 — Change management

| Criterion | Ai-Guard control | Status | Gap / operator action |
| --- | --- | --- | --- |
| CC8.1 Authorize & track changes | Versioned images (no floating `:latest`, pin by digest); **provenance attestations**; advisory-locked migrations; **versioned policy store** (validate → activate → rollback, audited) gated by `policy:write` | **Partial** | Operator's SDLC (PR review, approvals, ticketing) is the org control |

### CC1–CC5, CC9 — governance, risk, communication, vendor mgmt

| Criterion | Ai-Guard control | Status | Gap / operator action |
| --- | --- | --- | --- |
| CC1 Control environment (governance, HR) | — | **Roadmap** (org) | Entirely organizational — Ai-Guard has no bearing |
| CC2 Communication & information | Docs, error contract, correlation IDs | **Partial** | Internal policy comms are yours |
| CC3 Risk assessment | [Threat model](./threat-model.md) provided | **Partial** | Adopt into your risk program |
| CC4 Monitoring of controls | Metrics + logs | **Partial** | Control-effectiveness reviews are yours |
| CC5 Control activities | Documented in this pack | **Partial** | — |
| CC9 Vendor / subprocessor risk | Model-provider relationship is direct (self-host); [subprocessor outline](../commercial/security-questionnaire.md#subprocessors--data-processing) | **Partial** | You manage provider (OpenAI/Anthropic/etc.) as *your* subprocessors |

---

## Availability (A)

| Criterion | Ai-Guard control | Status | Gap / operator action |
| --- | --- | --- | --- |
| A1.1 Capacity | `/metrics` for saturation; [benchmarks harness](../deployment/benchmarks.md) for sizing | **Partial** | Published benchmark numbers not shipped — measure your own |
| A1.2 Recovery / backups | Stateless API/LiteLLM/Presidio; Postgres restore; [DR runbook](../runbooks/disaster-recovery.md) | **Partial** | Operator wires + tests backups; no built-in scheduler |
| A1.2 Redundancy / HA | Stateless replicas; shared Redis; atomic Postgres reservations; [HA reference architecture](../deployment/high-availability.md) | **Partial** | No turnkey HA chart; operator assembles managed Postgres/Redis + replicas |
| A1.3 Recovery testing | DR drill checklist provided | **Partial** (template) | Operator runs the drills |
| A1.1 Health / self-healing | `/health` (liveness) + `/ready` (readiness) probes; fail-closed dependencies | **Implemented** | Wire probes to LB/orchestrator |

---

## Confidentiality (C)

| Criterion | Ai-Guard control | Status | Gap / operator action |
| --- | --- | --- | --- |
| C1.1 Identify confidential data | [Data-flow doc](./data-flow.md): content transient by default; only metadata persisted | **Implemented** | Classify your own prompt data |
| C1.1 Minimize confidential data | Prompts/completions **not stored** in `request_logs`; `OBSERVABILITY_CAPTURE_CONTENT` and `IDEMPOTENCY_CAPTURE_CONTENT` default **off** | **Implemented** | Keep capture off unless required |
| C1.1 PII controls (DLP) | Presidio PII **mask/block**; prompt-injection block; **fails closed** on Presidio outage | **Implemented** | Use `balanced`/`strict` (not `dev`) in prod; coverage = Presidio recognizers |
| C1.2 Dispose of confidential data | `request_logs` retention sweep (`REQUEST_LOG_RETENTION_MS`, default 30d) + optional **per-feature `retention_days`**; idempotency auto-swept; **GDPR/CCPA erasure** via `POST /v1/admin/erasure` | **Implemented** | Set retention to your policy; content stores (if enabled) need their own disposal |
| C1.1 Restrict access to confidential data | Tenant-scoped keys (per-`projectId` partition; global counters hidden); permission-gated read endpoints | **Implemented** | Issue ops/tenant keys narrowly |
| C1.1 Encryption in transit/at rest | TLS at LB + `DATABASE_SSL`; DB encryption relies on infra | **Partial** | Operator enables encryption |

---

## Processing Integrity & Privacy

- **Processing Integrity (PI):** Not a primary Ai-Guard claim, but relevant
  mechanisms exist — atomic, cap-safe budget accounting (proven under concurrency
  in integration tests), idempotency keys for safe retries, and a stable error
  contract with stable `reasonCode`s. Status: **Partial** (accounting integrity
  implemented; broader PI is org-scoped).
- **Privacy (P):** Ai-Guard is a gateway, not a full data subject-rights
  platform, but it provides concrete primitives: DLP (Presidio),
  content-minimization defaults, per-feature retention, and a **right-to-erasure
  endpoint** (`POST /v1/admin/erasure`, `data:erase`) that deletes a user's
  request-linked data. Consent management and the broader DSAR process remain the
  operator/DPA responsibility (see
  [DPA outline](../commercial/security-questionnaire.md#dpa--subprocessor-outline)).

---

## What's still needed for a SOC 2 Type II audit

A Type II audit tests that controls **operated effectively over a period**
(typically 3–12 months). Beyond the technical controls above, you must:

1. **Define the audit scope & system description** — which environment, which TSC
   categories (Security is mandatory; add Availability/Confidentiality as scoped).
2. **Organizational controls Ai-Guard cannot provide** — HR onboarding/offboarding,
   security-awareness training, background checks, vendor management, physical/
   cloud-provider security (inherit via your cloud's SOC 2), risk assessments,
   board/management oversight (CC1–CC5, CC9).
3. **Operationalize the templates here** — actually run incident response, DR
   drills, and access reviews, and **retain evidence** (tickets, drill reports,
   review sign-offs) across the audit period.
4. **Continuous monitoring with retained evidence** — ship `/metrics` and logs to
   a SIEM with defined alerts; keep alert/response records.
5. **Change-management records** — PR reviews, approvals, deploy logs; leverage
   image provenance/SBOM as artifacts.
6. **Encryption everywhere** — enforce TLS (Ai-Guard has none built in) and
   at-rest encryption for Postgres, backups, and any content stores.
7. **Formal policies** — access control, data classification/retention, incident
   response, BCP/DR, secure SDLC — written, approved, and followed.
8. **Operationalize the shipped audit controls**: hash-chained admin audit
   logging (key/policy/erasure mutations) and chain verification are now
   **implemented** (`admin_audit_log`, `/v1/admin/audit/verify`); export them to
   a WORM/SIEM sink and schedule chain verification to satisfy an auditor's
   integrity + retention expectations.
9. **Engage a licensed CPA firm** to perform the examination — only they can issue
   the SOC 2 report.

**Honest bottom line:** Ai-Guard gives you a strong technical foundation for the
Security, Availability, and Confidentiality criteria — access control (DB-backed
keys + rotation, OIDC/RBAC), DLP, hash-chained admin audit, GDPR/CCPA erasure,
OpenTelemetry export, and fail-closed safety. It does **not** by itself make you
SOC 2 compliant: the remaining work is (a) organizational controls and written
policies, and (b) operationalizing + evidencing the runbooks in this pack.
