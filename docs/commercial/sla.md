# Service Level Agreement (template)

> **Template only — not a commitment from the Modelgov project.** Modelgov ships
> as self-hosted software with **no vendor-operated SLA** today. This template is
> for a party that **operates** Modelgov (a commercial provider or an internal
> platform team) and wishes to offer an SLA to its customers/downstream teams.
> Replace every **`[BRACKETED]`** value. Targets below are illustrative defaults
> aligned with the [HA reference architecture](../deployment/high-availability.md).

**Provider:** `[PROVIDER LEGAL ENTITY]`  ·  **Effective date:** `[DATE]`  ·
**Version:** `[X.Y]`

---

## 1. Scope

This SLA covers the availability and support of the **Modelgov control plane API**
operated by `[PROVIDER]` for `[CUSTOMER]`. It applies to the `/v1/*` request path
and control-plane endpoints.

**Explicitly excluded from availability calculations:**

- **Upstream model-provider outages** (OpenAI, Anthropic, Gemini, Bedrock, etc.).
  Modelgov returns `502 provider_unavailable` after exhausting the configured
  `fallback` model class; provider downtime counts against the provider, not this
  SLA. Fallback across providers is the mitigation.
- Scheduled maintenance announced ≥ `[48]` hours in advance (max `[4]` hours/month).
- Customer-caused issues: misconfiguration of `modelgov.yaml`, exhausted budgets
  (a correct `403 budget_exceeded` is **not** downtime), rate-limit rejections
  from customer traffic, invalid API keys, or customer network/DNS faults.
- Force majeure and cloud-provider regional outages beyond `[PROVIDER]`'s HA design.

---

## 2. Availability commitment

**Availability** = percentage of one-minute intervals in the calendar month in
which the API served `GET /ready` successfully **and** did not return gateway-origin
`5xx` for a majority of valid `/v1/*` requests. Provider-origin `502` and
customer-origin `4xx` (including `403 budget_exceeded`, `429`) are excluded.

| Tier | Monthly uptime target | Max downtime/month |
| --- | --- | --- |
| Enterprise | `[99.9%]` | ≈ 43 min |
| Business | `[99.5%]` | ≈ 3 h 39 min |
| Community | No SLA (best-effort) | — |

The 99.9% target assumes the [HA reference architecture](../deployment/high-availability.md):
managed HA Postgres, ≥3 API replicas across ≥2 AZs, ≥2 LiteLLM/Presidio replicas,
managed HA Redis.

---

## 3. Support response & resolution targets

Response = time to first substantive human response. Resolution = fix, workaround,
or mitigation. Times are within the support hours of the customer's
[support tier](./support-tiers.md).

| Severity | Definition | Response target | Resolution target |
| --- | --- | --- | --- |
| **SEV1 — Critical** | Full outage; API down or rejecting all valid traffic; data-loss risk | `[15 min]` (Ent) / `[1 h]` (Bus) | `[4 h]` / `[1 business day]` |
| **SEV2 — High** | Major degradation; a core function impaired (e.g. safety failing closed cluster-wide, DB failover) with no workaround | `[1 h]` / `[4 h]` | `[1 business day]` / `[3 business days]` |
| **SEV3 — Medium** | Partial/intermittent issue with a workaround | `[1 business day]` | `[5 business days]` |
| **SEV4 — Low** | Question, cosmetic, or feature request | `[2 business days]` | Best-effort / roadmap |

Severity definitions align with the [incident-response runbook](../runbooks/incident-response.md).

---

## 4. Service credits

If monthly uptime falls below the committed target, `[CUSTOMER]` may request a
credit against the affected month's fees.

| Monthly uptime achieved (vs `[99.9%]` target) | Service credit |
| --- | --- |
| < 99.9% and ≥ 99.0% | `[10%]` of monthly fee |
| < 99.0% and ≥ 95.0% | `[25%]` of monthly fee |
| < 95.0% | `[50%]` of monthly fee |

**Claim process:** submit within `[30]` days of the affected month via
`[SUPPORT CHANNEL]`, including approximate timestamps and `requestId` /
`x-modelgov-request-id` values where available. Credits are the **sole and
exclusive remedy** for availability misses and are capped at `[100%]` of the
monthly fee. Credits do not apply to the excluded categories in §1.

---

## 5. Monitoring & reporting

- `[PROVIDER]` monitors availability via `/ready` checks and Prometheus `/metrics`
  (request/error/latency, pg pool saturation) — see [operations metrics](../operations.md#metrics).
- Availability reports are published `[monthly]` at `[STATUS PAGE / REPORT URL]`.
- Incidents are communicated per the [incident-response runbook](../runbooks/incident-response.md)
  comms templates.

---

## 6. Customer responsibilities

To be eligible for SLA credits, `[CUSTOMER]` must:

- Keep API keys valid and rotate per policy; use scoped keys with least privilege.
- Configure budgets and features correctly; a policy/budget block is expected
  behavior, not an outage.
- Report incidents promptly via `[SUPPORT CHANNEL]` with correlation IDs.
- For self-managed deployments, follow the [production checklist](../operations.md#production-checklist)
  and [HA architecture](../deployment/high-availability.md) — an SLA cannot exceed
  the resilience of the customer's own Postgres/Redis/LB.

---

*This is a template. `[PROVIDER]` and `[CUSTOMER]` must execute a signed agreement;
the operative terms are those in the signed contract, not this document.*
