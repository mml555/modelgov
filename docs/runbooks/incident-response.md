# Incident response runbook

How to classify, escalate, communicate, and learn from incidents affecting an
Modelgov deployment. This is an **operational template** — Modelgov ships the
technical signals (health/readiness, `/metrics`, structured logs, correlation
IDs, stable error contract) that this process relies on; the on-call staffing,
comms channels, and cadence are the operator's to fill in (`[BRACKETED]`).

For security-vulnerability reports specifically, use the private disclosure
process in [SECURITY.md](../../SECURITY.md), not this runbook.

---

## Severity classification

| Sev | Definition | Examples (Modelgov) | Response |
| --- | --- | --- | --- |
| **SEV1 — Critical** | Full outage or data-loss risk; all/most valid traffic failing | `/ready` failing fleet-wide; Postgres down (`500` on `/v1/chat`); suspected data loss/corruption; active security breach | Page on-call immediately; assign incident commander; customer comms |
| **SEV2 — High** | Major function impaired, no workaround | Safety failing closed cluster-wide (`503 safety_unavailable` — all Presidio down); DB failover in progress; sustained elevated 5xx; Redis down causing fleet-wide `429` (fail-closed) | Page on-call; comms if customer-visible |
| **SEV3 — Medium** | Partial/intermittent, workaround exists | One replica unhealthy; elevated latency (p95 breach) without errors; single LiteLLM replica down (fallback absorbing); budget-alert webhook failing | Handle in business hours |
| **SEV4 — Low** | Minor / no user impact | Cosmetic log noise; a single tenant's misconfiguration; feature request | Backlog |

**Not incidents (expected behavior — do not page):**

- `403 budget_exceeded` / `403 policy_blocked` / `403 safety_blocked` — the gateway
  is doing its job.
- `429` rate-limit rejections from legitimate over-limit traffic.
- `502 provider_unavailable` caused by an **upstream provider** outage after
  fallback is exhausted — this is a provider incident; track it, escalate to the
  provider, but it is excluded from Modelgov availability.

Confirm severity fast with:

```bash
curl -sf "$MODELGOV_URL/ready" | jq .        # db/litellm/presidio status
curl -s  "$MODELGOV_URL/metrics" -H "Authorization: Bearer $METRICS_TOKEN" \
  | grep -E 'http_requests_total|pg_pool_clients_waiting|http_request_duration'
```

`/ready` reports DB (gates readiness) plus LiteLLM/Presidio status in the body —
the fastest triage signal for which dependency is at fault. See
[failure semantics](../failure-semantics.md) for what each dependency failure
produces.

---

## On-call & escalation flow

```text
Detection (alert / customer report / status check)
        │
        ▼
 On-call engineer  ── assess & assign severity (SEV1–4)
        │
        ├── SEV3 / SEV4 ─► triage, mitigate, ticket, resolve
        │
        └── SEV1 / SEV2 ─► declare incident
                 │
                 ├─► SEV1: assign INCIDENT COMMANDER (IC)
                 │        - owns decisions, delegates, not hands-on-keyboard
                 │        - assigns Comms lead + Ops lead(s)
                 │
                 ├─► open incident channel [#incident-YYYYMMDD-slug]
                 ├─► start timeline / status log
                 ├─► post initial status-page update (customer-facing)
                 └─► escalate to [SECONDARY / ENG LEAD] if unresolved in [30 min]
                          │
                          ▼
                  Resolve → monitor → all-clear → post-mortem (SEV1/SEV2)
```

**Roles (SEV1):**

- **Incident Commander** — coordinates, decides, delegates. Not fixing directly.
- **Ops lead(s)** — investigate/mitigate (DB failover, replica restart, roll back).
- **Comms lead** — internal updates + customer/status-page updates.
- **Scribe** — maintains the timeline (UTC timestamps, actions, findings).

**Escalation triggers:** unresolved SEV1 after `[30 min]`; SEV2 crossing into
customer-visible impact; any suspected security breach → also invoke
[SECURITY.md](../../SECURITY.md) disclosure/handling and preserve evidence.

**First-response playbook by symptom** (from [failure semantics](../failure-semantics.md)):

| Symptom | Likely cause | First action |
| --- | --- | --- |
| `/ready` not ready, `500` on chat | Postgres down/unreachable | Check DB health/failover; verify `DATABASE_URL`; see [DR runbook](./disaster-recovery.md) |
| `503 safety_unavailable` cluster-wide | Presidio down | Restart/scale Presidio; safety stays closed until healthy (correct) |
| Fleet-wide `429` with `REDIS_URL` set | Redis down (fail-closed limiter) | Restore Redis; consider temporary `RATE_LIMIT_FAIL_OPEN=true` only with sign-off |
| `502 provider_unavailable` | Provider + fallback both failing | Check provider status/quota/creds; verify a cross-provider `fallback` is configured |
| p95 latency breach, no errors | Saturation | Check `pg_pool_clients_waiting`, replica count, `DB_POOL_MAX`; scale API |

---

## Communication templates

### Internal — incident declared

```
[SEV{N}] {short title} — DECLARED {UTC time}
Impact: {who/what is affected, endpoints, tenants}
Symptoms: {5xx rate / 503 / 429 / latency; /ready status}
Suspected cause: {dependency or unknown}
IC: {name}  Ops: {name}  Comms: {name}
Channel: {#incident-...}
Next update: {UTC time, within 30 min for SEV1}
```

### Internal — update

```
[SEV{N}] {title} — UPDATE {UTC time}
Status: {investigating | identified | mitigating | monitoring}
What changed: {action taken + effect on metrics}
Current impact: {...}
Next update: {UTC time}
```

### Customer / status page — initial

```
Investigating — {UTC time}
We are investigating {elevated errors / degraded availability} affecting the
Modelgov API. Some requests may {fail / be delayed}. Note: policy, budget, and
safety blocks are functioning normally and are not part of this incident.
We will post an update within {30 minutes}.
```

### Customer / status page — resolved

```
Resolved — {UTC time}
The issue affecting {component} has been resolved as of {UTC time}. Root cause:
{one line}. Total impact window: {start–end UTC}. A post-mortem will follow within
{5 business days}. If you continue to see errors, contact {SUPPORT CHANNEL} with
your requestId / x-modelgov-request-id.
```

Ask customers to include `requestId` / `x-modelgov-request-id` — every response
and most errors carry it (see [API correlation](../api.md#request-correlation)),
which maps directly to an audit row via `modelgov requests show`.

---

## Post-mortem template (SEV1/SEV2)

Blameless. Complete within `[5 business days]`.

```markdown
# Post-mortem: {title}

- **Date / duration:** {UTC start – end}  ·  **Severity:** SEV{N}
- **Author / IC:** {name}  ·  **Status:** draft | reviewed

## Summary
{2–3 sentences: what happened, impact, resolution.}

## Impact
- Users/tenants affected, endpoints, error types (5xx / 503 / 429).
- Requests failed/degraded (from `http_requests_total` / logs).
- SLA/credit implications (see [SLA](../commercial/sla.md)).
- Data integrity: any budget-counter/audit impact? Orphaned reservations
  (released after `RESERVATION_STALE_MS`)?

## Timeline (UTC)
| Time | Event |
| --- | --- |
| | Detection ({alert / report}) |
| | Severity assigned; IC engaged |
| | Mitigation applied |
| | Recovery confirmed (/ready green) |
| | All-clear |

## Root cause
{Technical root cause. Which dependency/config/change. Link to failure-semantics
behavior if a fail-closed path triggered as designed.}

## Detection
{How found; time-to-detect. Did existing alerts (`/metrics`, budget webhook) fire?}

## What went well / what didn't
- Went well: ...
- Didn't: ...

## Action items
| # | Action | Owner | Due | Priority |
| --- | --- | --- | --- | --- |
| 1 | {e.g. add alert on pg_pool_clients_waiting} | | | |
| 2 | {e.g. add LiteLLM replica to remove SPOF — see HA doc} | | | |
| 3 | {e.g. lower API_KEY_CACHE_TTL_MS if revocation latency mattered} | | | |
```

Feed action items back into the [HA architecture](../deployment/high-availability.md),
[DR runbook](./disaster-recovery.md), and monitoring
([operations metrics](../operations.md#metrics)).

Related: [SLA](../commercial/sla.md) · [support tiers](../commercial/support-tiers.md)
· [failure semantics](../failure-semantics.md) · [threat model](../compliance/threat-model.md).
