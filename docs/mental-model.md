# Mental model

Ai-Guard is a **self-hosted AI policy gateway**. One short rule:

> **Your app decides whether the user may ask. Ai-Guard decides whether the AI request may run.**

## Where it sits

```text
Your app (auth + business logic)
  ↓
@ai-guard/sdk
  ↓
Ai-Guard API (budgets, safety, routing)
  ↓
LiteLLM → OpenAI / Anthropic / …
```

Your app still owns login, RBAC, and product permissions. Ai-Guard never
substitutes for those checks.

## What your app passes

Every guarded call includes:

| Field | Purpose |
| --- | --- |
| `userId` | Who is spending budget |
| `userType` | Which budget tier (`free_user`, `paid_user`, …) |
| `feature` | Which product AI use case (`support_chat`, `document_extraction`, …) |
| `modelClass` | Optional override (`cheap`, `standard`, `premium`) |
| `messages` | The prompt (chat) or instructions |

`feature` is required. Untracked generic LLM calls are not allowed.

## What Ai-Guard returns

| Outcome | Meaning |
| --- | --- |
| **allow** | Policy passed; model called at the requested (or default) class |
| **degrade** | Budget pressure or routing rule downgraded the model class |
| **fallback** | Primary provider failed; fallback model was used |
| **block** | Policy or budget rejected the request — **no model call** |

Blocked requests return a structured error (`policy_blocked`, `budget_exceeded`).
Safety rejections return `safety_blocked` (PII or prompt injection).

Successful responses include `budgetRemaining`, `cost`, and `safety` flags.

## Debug before you spend

Use **explain** to dry-run policy without calling a model:

```bash
# Offline — reads ai-guard.yaml only
pnpm ai-guard explain --local \
  --userType logged_in --feature support_chat --modelClass premium

# Live — includes real budget counters from Postgres
AI_GUARD_API_KEY=sk-... pnpm ai-guard explain \
  --userType logged_in --feature support_chat --modelClass premium
```

Or `POST /v1/explain` / `client.explain()` from the SDK.

## What Ai-Guard does **not** do

- Decide if user `admin_42` may edit `restaurant_456` (your RBAC)
- Store chat history for your product UI (your database)
- Replace your app's session or OAuth layer

Pass `userType: "admin"` only **after** your app confirms the user is an admin.
Ai-Guard uses `userType` for **AI policy**, not product authorization.

## Further reading

- [Integration checklist](./integration-checklist.md)
- [Configuration reference](./configuration.md)
- [Architecture](./ARCHITECTURE.md)
