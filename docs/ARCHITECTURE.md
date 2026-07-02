# Ai-Guard Architecture

Ai-Guard is a **server-first universal AI control plane**. Applications call a
central API; the API loads shared budget state, runs a **pure Policy Engine**,
enforces safety, reserves budget, calls **LiteLLM** for provider execution, and
records results. Optional **Langfuse** tracing is available in full deploy mode.

> **Ai-Guard enforces AI policy. Your app enforces business authorization.**

That boundary is intentional and non-negotiable. Ai-Guard decides whether an AI
call is allowed under *cost, safety, routing, and usage* rules. Your application
decides whether the *human or workflow* is allowed to perform the underlying
product action.

---

## What Ai-Guard owns vs what your app owns

| Ai-Guard enforces | Your app enforces |
| --- | --- |
| Per-user / per-feature AI budgets | Whether the user may access a record |
| Allowed model classes per user type | Publishing, deleting, or editing domain data |
| Safety presets (PII, prompt injection) | Role-based product permissions (RBAC) |
| Rate limits and token caps | Workflow approvals (e.g. “may this agent post?”) |
| Model routing (primary / fallback / degrade) | Tenant isolation and data scope |
| Usage logging and cost attribution | OAuth/session authorization |

**Typical flow:** your app authenticates the user, checks product permissions,
*then* calls Ai-Guard with `userId`, `userType`, and a registered `feature`.
Ai-Guard never substitutes for that first step.

**Anti-pattern:** assuming Ai-Guard “knows” that an admin may edit listing
`restaurant_456`. Pass `userType: "admin"` only after *your* RBAC confirms it.
Ai-Guard uses `userType` for **AI policy** (budgets, model access), not for
product authorization.

---

## Layered architecture

```text
App (your RBAC + business logic)
  ↓
@ai-guard/sdk                    — typed HTTP client; feature names from ai-guard.yaml
  ↓
Ai-Guard API                     — Postgres, reservation, safety I/O, LiteLLM
  ↓
evaluateAiRequest()              — PURE Policy Engine (no I/O)
  ↓
LiteLLM                          — provider execution
  ↓
OpenAI / Anthropic / …
```

### Policy Engine (pure)

`packages/policy-engine` exports `evaluateAiRequest({ request, config, usage })`.

- **Input:** request metadata, parsed `ai-guard.yaml`, and a **pre-loaded**
  `UsageSnapshot` (`used` + `reserved` per budget dimension).
- **Output:** `allow | block | degrade | fallback`, resolved model, safety plan,
  estimated cost, trace tags.
- **No side effects** — no database, network, or clock. Fully unit-testable.

Contract violations (unknown `feature`, `user_type`, or `model_class`) throw
`PolicyConfigError`; the API maps those to HTTP 400.

### API service layer (stateful)

`packages/api` owns all I/O:

1. `loadUsageSnapshot()` — read counters from Postgres
2. `evaluateAiRequest()` — pure decision
3. Safety inspection (Presidio PII + injection classifier)
4. `reserveBudget()` — atomic reservation before the model call
5. `callLiteLLM()` — primary model; `forceFallback` re-eval on provider failure
6. `recordActualCost()` / `releaseBudget()` — settle or roll back reservation
7. Audit log + optional Langfuse trace

### Mandatory `feature`

Every `POST /v1/chat` must include `feature` matching a key in `ai-guard.yaml`
`features:`. This prevents untracked generic LLM usage.

The SDK generates `FeatureName`, `UserTypeName`, and `ModelClassName` unions
from `ai-guard.yaml` (`pnpm generate-sdk-types`) so invalid feature names fail
at compile time in TypeScript consumers.

---

## Budget reservation

Concurrent requests must not all pass a snapshot check before any spend is
recorded. The API:

1. Evaluates policy against `used + reserved`
2. Atomically increments `reserved_usd` (and request count) under row locks
3. Calls the model
4. Moves `reserved → actual` on success, or releases reservation on failure

The deterministic proof lives in `usage.integration.test.ts` (exact admission
count under concurrency). End-to-end behavior is covered in `chat.integration.test.ts`.

---

## v1 routing (intentionally boring)

Per model class in `ai-guard.yaml`:

- **primary** — used on `allow` / `degrade`
- **fallback** — used when the primary provider fails (`fallback` decision)
- **budget-aware degrade** — downgrade one model class when global spend crosses
  `routing.degrade_at_percent`

Post-MVP: experiments, latency optimization, weighted rotation.

---

## Configuration

`ai-guard.yaml` is the product control surface. `litellm_config.yaml` is
**generated** from it for the execution backend — do not hand-edit LiteLLM config
as the source of truth.

---

## Deploy modes

| Mode | Stack |
| --- | --- |
| **simple** (default) | Ai-Guard API + LiteLLM + Postgres + Presidio |
| **full** | simple + Langfuse |
| **local** | simple routed to Ollama (no cloud provider keys) |

---

## Future: actor vs subject (not in v1)

Some products need to distinguish who *acts* vs what *entity* is affected:

```typescript
actor: { id: "user_123", type: "admin" },
subject: { type: "listing", id: "restaurant_456" },
```

v1 uses `userId` + `userType` only. Actor/subject would extend policy and audit
without replacing app-level authorization.

---

## Package map

| Package | Responsibility |
| --- | --- |
| `@ai-guard/policy-engine` | Pure policy + YAML parsing |
| `@ai-guard/api` | HTTP server, Postgres, LiteLLM, safety |
| `@ai-guard/sdk` | Typed client to `/v1/chat` |
| `create-ai-guard` | Scaffold wizard for new projects |

---

## Testing

- **Unit tests** — policy engine, safety, auth, SDK (no Postgres).
- **Integration tests** — require `DATABASE_URL` (Postgres). CI sets this via a
  service container on port `55432`. Locally:

  ```bash
  make test-db
  # or manually:
  docker run -d --name aiguard-test-pg \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=aiguard \
    -p 55433:5432 postgres:16-alpine
  DATABASE_URL=postgres://postgres:postgres@localhost:55433/aiguard pnpm test
  ```

Integration test files run serially (`fileParallelism: false` in Vitest) because
they share one database and `TRUNCATE` between cases.
