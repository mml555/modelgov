# Integration checklist

Add Ai-Guard to an existing app in about 20 minutes.

## 1. Deploy Ai-Guard (5 min)

```bash
npx create-ai-guard my-project   # or clone this repo
cd my-project
make setup                       # creates .env if needed, starts, waits, smoke-tests
```

> Note: the packages (`create-ai-guard`, `@ai-guard/sdk`, `ai-guard-sdk`) are not
> yet published to npm/PyPI. Until then, run from source — see
> [self-host.md](./self-host.md).

Stack: Ai-Guard API + LiteLLM + Postgres + Presidio.

Verify:

```bash
curl http://localhost:3000/health
```

## 2. Define policy (5 min)

Edit `ai-guard.yaml`:

```yaml
features:
  support_chat:
    safety: strict
    model_class: cheap
    max_tokens: 500

budgets:
  by_user_type:
    logged_in:
      daily_usd: 0.25
      daily_requests: 50
      models: ["cheap", "standard"]
```

Regenerate SDK types if your app imports them:

```bash
pnpm generate-sdk-types
```

## 3. Wire the SDK (5 min)

```ts
import { createAiGuardClient } from "@ai-guard/sdk";

const ai = createAiGuardClient({
  baseUrl: process.env.AI_GUARD_URL!,
  apiKey: process.env.AI_GUARD_API_KEY!,
});

// After YOUR auth + RBAC checks:
const res = await ai.chat({
  userId: session.userId,
  userType: session.plan,        // "free_user" | "paid_user" | …
  feature: "support_chat",
  messages: [{ role: "user", content: userMessage }],
});
```

Replace direct `openai.chat.completions.create()` (or equivalent) with `ai.chat()`.

### API key scoping (important)

Ai-Guard trusts the `userId` and `userType` your app sends — it does not authenticate end users.
Scope keys so a compromised server credential cannot impersonate arbitrary users:

- Issue **per-service** keys with `permissions: ["chat:create"]` only.
- Set **`allowedUserTypes`** when a key should only serve certain policy tiers (e.g. `"free_user"`).
- Set **`allowedUserIds`** when a key is bound to a single integration (e.g. a batch job user).
- Use **separate keys per tenant** (`tenantId`, `projectId`) for multi-tenant products.
- Rotate via the DB key store (`ai-guard keys …` / `POST /v1/admin/keys`) instead of redeploying env secrets.

See [Configuration — scoped API keys](./configuration.md#scoped-api-keys-multi-tenant-operators).

## 4. Handle blocked requests (2 min)

```ts
import { PolicyBlockedError, SafetyBlockedError } from "@ai-guard/sdk";

try {
  const res = await ai.chat({ ... });
} catch (err) {
  if (err instanceof PolicyBlockedError) {
    // Budget or model-class limit — show upgrade / retry message
  }
  if (err instanceof SafetyBlockedError) {
    // PII or injection — reject input
  }
  throw err;
}
```

## 5. Verify policy (3 min)

Before shipping, explain the paths you care about:

```bash
ai-guard explain --local --userType free_user --feature support_chat --modelClass premium
ai-guard explain --local --userType paid_user --feature support_chat --modelClass standard
```

Or against live budget state:

```bash
AI_GUARD_API_KEY=sk-... ai-guard explain --userType paid_user --feature support_chat
```

## Production checklist

- [ ] Set `AI_GUARD_PRODUCTION=true` and run `pnpm ai-guard doctor prod --strict` before go-live
- [ ] Copy [`ai-guard.production.example.yaml`](../ai-guard.production.example.yaml) and [`.env.production.example`](../.env.production.example)
- [ ] Set scoped API keys (`chat:create` for app servers, `usage:read` for ops)
- [ ] Configure `BUDGET_ALERT_WEBHOOK_URL` for spend alerts
- [ ] Enable Redis-backed rate limiting (`REDIS_URL`)
- [ ] Run `make up-prod` or your own K8s manifests
- [ ] Back up Postgres (`budget_counters`, `request_logs`) — see [Operations](./operations.md)
- [ ] Remove provider API keys from app servers (LiteLLM holds them)

## Examples

| Example | Shows |
| --- | --- |
| [`support_chat`](../examples/support_chat) | Chat, PII, injection, daily budget |
| [`saas_tiers`](../examples/saas_tiers) | Free vs paid model access |
| [`document_extraction`](../examples/document_extraction) | Non-chat workflow, daily cap |
| [`event_intake_app`](../examples/event_intake_app) | Full Jewgo-style integration pattern |

For a complete production embedding guide (auth → Ai-Guard → correlation logging),
see [Real app pattern](./integrations/real-app-pattern.md).

## Docs

- [Mental model](./mental-model.md) — who owns what
- [Configuration](./configuration.md) — full `ai-guard.yaml` reference
- [HTTP API](./api.md) — REST, auth, idempotency
- [Operations](./operations.md) — health, backups, scaling
