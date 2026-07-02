# Dependency failure semantics

How Ai-Guard behaves when infrastructure dependencies are unavailable.
Designed to **fail closed** on policy and safety, **degrade gracefully** on
observability, and **never leak budget** on partial failures.

## Summary

| Dependency | Request impact | Rationale |
| --- | --- | --- |
| **Postgres** | Requests fail (500 on chat; `/ready` not ready) | No budget reservation or audit without DB |
| **Request audit insert** | `503 audit_unavailable`; model output is withheld | Every admitted/blocked guarded request must have durable request metadata |
| **Admin audit insert** | Privileged mutation rolls back and returns 500 | Key/policy/erasure mutations must not commit without an admin audit row |
| **LiteLLM / provider** | Fallback model if configured; else `502 provider_unavailable` | Provider outage should not silently succeed |
| **Presidio / safety** | `503 safety_unavailable` when PII/injection protection is enabled | Strict safety fails closed — no unguarded model call |
| **Langfuse** | Request proceeds; trace export best-effort | Observability must never block product traffic |
| **Redis (rate limit)** | `RATE_LIMIT_FAIL_OPEN=true` → allow; default with Redis → fail closed on limiter errors | Configurable; production compose sets fail-closed |

## Postgres

- **`/health`** — always `200` if the process is alive (does not query Postgres).
- **`/ready`** — `not_ready` when Postgres ping fails. Orchestrators should stop routing traffic.
- **`POST /v1/chat`** — `loadUsageSnapshot` / `reserveBudget` throw → `500 internal_error`.
- **Request audit write failure** — returns `503 audit_unavailable`. If the
  provider call already ran and cost was settled, idempotency marks the failure
  non-retryable so a keyed retry does not re-run the model and double-charge.
- **Admin audit write failure** — key create/rotate/revoke, policy save/activate,
  and data erasure are wrapped with the admin audit append in one transaction;
  the mutation rolls back if the audit row cannot be written.

Budget reservations use row locks. Without Postgres, concurrent spend cannot be enforced.

## LiteLLM / providers

1. Policy allows the request and budget is reserved.
2. Primary model call fails with a provider error.
3. If the model class has a **fallback** configured, the API re-evaluates with `forceFallback: true` and retries on the fallback model. The re-evaluation re-applies the **data-sensitivity gate**: if the fallback model's provider is not approved for the feature's data class, the request fails with `403 policy_blocked` (`data_sensitivity_not_permitted`) and the reservation is released — the primary is never retried and no data reaches the unapproved provider.
4. If fallback also fails, or no fallback exists → **`502 provider_unavailable`** and reservation is released.

Settlement: if the model call succeeded but `recordActualCost` fails, the reservation is **left in place** for the lease-cleanup sweep rather than released (prevents budget leaks).

## Safety (Presidio + injection classifier)

| Phase | Backend down |
| --- | --- |
| **Input safety** (before model) | `503 safety_unavailable` — request blocked |
| **Output safety** (after model, cost booked) | `503 safety_unavailable`, `retryable: false` — idempotency key retained |

When `safety.preset: dev` and protections are off, safety is a no-op (`NoopGuard`) and Presidio is not required.

### Classifier cost on rejected requests

The injection classifier makes a **billable model call** as part of input safety.
That spend is booked to the caller's `used_usd` on every path where it was
incurred — including requests that are then **safety-blocked**, rejected at
budget reservation, or fail at the provider. The audit row carries it as
`actualCostUsd`. Two invariants:

- **Booking never gates.** A safety block stays `403 safety_blocked`; it never
  flips to `budget_exceeded` because the classifier spend pushed a counter over
  its cap. Any overshoot surfaces on the *next* request's policy gate.
- Features with strict injection/PII presets therefore incur per-request
  classifier cost **even on blocked requests** — expected, since the caller
  triggered the scan.

## Langfuse

`LangfuseObservability.recordChat()` is wrapped in try/catch. Export failures are swallowed; chat responses are unaffected.

## Redis rate limiting

| Config | Behavior |
| --- | --- |
| No `REDIS_URL` | In-memory limiter per API instance |
| `REDIS_URL` + default | Limiter errors reject requests (fail closed) |
| `REDIS_URL` + `RATE_LIMIT_FAIL_OPEN=true` | Limiter errors allow requests through |

## Stable error contract

Policy and budget blocks return structured fields in `error.details`:

```json
{
  "error": {
    "code": "policy_blocked",
    "message": "Model class not permitted for user type logged_in",
    "details": {
      "decision": "block",
      "feature": "support_chat",
      "userType": "logged_in",
      "userId": "user_123",
      "reasonCode": "model_class_not_permitted",
      "reason": "model_class 'standard' is not permitted for user_type 'logged_in'",
      "budgetRemaining": { "userDailyUsd": 0.24, "featureMonthlyUsd": null, "globalMonthlyUsd": 499.5 },
      "resolvedModelClass": "standard",
      "auditRequestId": "req_42"
    },
    "requestId": "..."
  }
}
```

`reasonCode` values are stable across releases:

| `reasonCode` | Meaning |
| --- | --- |
| `model_class_not_permitted` | User type cannot use requested model class |
| `data_sensitivity_not_permitted` | Feature's data class does not permit the resolved model class or provider (also applies on fallback re-evaluation) |
| `daily_request_limit_reached` | Daily request count exhausted |
| `daily_budget_exceeded` | User daily USD cap exceeded |
| `feature_monthly_budget_exceeded` | Feature monthly cap exceeded |
| `global_monthly_budget_exceeded` | Global monthly hard stop |
| `global_budget_degraded` | Global spend triggered model downgrade |
| `provider_fallback` | Primary failed; using fallback model |

## Testing

Automated coverage: `packages/api/test/failure-semantics.test.ts`

Policy regression: `ai-guard.policy-tests.yaml` + `pnpm ai-guard test-policy`
