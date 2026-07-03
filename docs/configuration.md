# Configuration reference

Modelgov is controlled by **`modelgov.yaml`** — the single source of truth for
budgets, features, models, safety, and routing. The API loads this file at
startup (`MODELGOV_CONFIG` env var). LiteLLM config is **generated** from it for
provider execution; do not treat `litellm_config.yaml` as the policy source.

## File structure

```yaml
project:
  name: my-app
  environment: production

providers:
  openai:
    api_key: env/OPENAI_API_KEY
  anthropic:
    api_key: env/ANTHROPIC_API_KEY

budgets:
  global: { ... }
  by_user_type: { ... }

features:
  support_chat: { ... }

routing:
  degrade_at_percent: 80

model_classes:
  cheap: { primary: ..., fallback: ... }

safety:
  preset: balanced
  protect: { ... }

observability:
  provider: none
```

Keys use **snake_case** in YAML; the policy engine normalizes to camelCase internally.

---

## `project`

| Field | Required | Description |
| --- | --- | --- |
| `name` | Yes | Project identifier; default `projectId` on API requests |
| `environment` | No | Default `development`; e.g. `production`, `staging` |

---

## `providers`

Maps provider id → credentials reference. The API resolves `env/VAR_NAME` to the
process environment at startup.

```yaml
providers:
  openai:
    api_key: env/OPENAI_API_KEY
```

The pure policy engine never reads API keys.

---

## `budgets`

### `budgets.global`

| Field | Type | Description |
| --- | --- | --- |
| `monthly_usd` | number | Global monthly spend cap (USD). `0` = no global cap |
| `alert_at_percent` | 0–100 | Log a warning when spend crosses this % of monthly cap; optional webhook (see below) |
| `hard_stop_at_percent` | 0–100 | Block new requests at this % of monthly cap (default 100) |
| `monthly_tokens` | number | Optional global monthly **token** cap (input + output). Omit = no token limit |

When global spend (used + reserved) crosses `degrade_at_percent` (see routing),
the engine may **degrade** to a cheaper permitted model class.

### `budgets.by_user_type`

Map of user type → limits. Your app sends `userType` on each request; it must
match a key here.

| Field | Type | Description |
| --- | --- | --- |
| `daily_usd` | number | Max USD per user per day (used + reserved) |
| `daily_requests` | number | Max requests per user per day |
| `daily_tokens` | number | Optional max **tokens** per user per day (input + output). Omit = no token limit |
| `models` | string[] | Allowed model classes, e.g. `["cheap", "standard"]` |

**Token limits vs cost:** every request reserves a worst-case token estimate
(declared/assumed input + the feature's `max_tokens`) up front, and settles the
provider's actual token usage after — exactly like cost. Set `daily_tokens` /
`monthly_tokens` (per user, feature, or global) to cap on tokens independently of
USD. A breach returns `403` with `reasonCode` `daily_token_limit_reached`,
`feature_monthly_token_limit_reached`, or `global_monthly_token_limit_reached`.
Useful with local/self-hosted models where per-token cost is ~0 but throughput
still needs bounding.

Example:

```yaml
by_user_type:
  anonymous:
    daily_usd: 0.02
    daily_requests: 5
    models: ["cheap"]
  logged_in:
    daily_usd: 0.25
    daily_requests: 50
    models: ["cheap", "standard"]
  admin:
    daily_usd: 10
    daily_requests: 500
    models: ["cheap", "standard", "premium"]
```

---

## `features` (required registry)

**Every API call must name a `feature` that exists here.** This prevents untracked
generic LLM usage.

| Field | Type | Description |
| --- | --- | --- |
| `model_class` | string | Default model class if caller omits `modelClass` |
| `max_tokens` | int | Max output tokens for this feature |
| `safety` | preset or object | Override global safety (`strict`, `balanced`, `dev`, or `{ preset, protect }`) |
| `budget.monthly_usd` | number | Optional per-feature monthly cap |

```yaml
features:
  support_chat:
    safety: strict
    model_class: cheap
    max_tokens: 500
  event_extraction:
    safety: balanced
    model_class: standard
    max_tokens: 1500
    budget:
      monthly_usd: 100
```

After adding features, regenerate SDK types:

```bash
pnpm generate-sdk-types
```

---

## `model_classes`

Defines **primary** and **fallback** models per tier. Apps request a class
(`cheap`, `standard`, `premium`), not a raw model name.

```yaml
model_classes:
  cheap:
    primary: openai/gpt-4o-mini
    fallback: anthropic/claude-haiku
  standard:
    primary: anthropic/claude-sonnet
    fallback: openai/gpt-4o
```

- **allow** → `primary`
- **fallback** (provider failure) → `fallback`
- **degrade** → one tier cheaper (if permitted for user type)

---

## `pricing` (optional — custom token prices)

Modelgov ships a built-in price table for common OpenAI/Anthropic/Gemini models.
For anything it doesn't know — **OpenRouter**, **Azure** deployments, self-hosted
models you bill internally, or a negotiated rate — declare the price so budget
estimates (and the settled-cost fallback) are accurate:

```yaml
pricing:                                   # USD per 1K tokens, keyed by model string
  "openrouter/anthropic/claude-3.5-sonnet": { input_per_1k: 0.003, output_per_1k: 0.015 }
  "azure/gpt-4o-mini":                       { input_per_1k: 0.00015, output_per_1k: 0.0006 }
```

- Overrides the built-in table for that model; extends it for unknown models.
- A model with a `pricing` entry is no longer flagged "unpriced" at startup.
- Local/Ollama models (`ollama/…`, no `/`) are price-exempt unless you list them
  here — handy to enforce **token** budgets on free local models with `$0` cost.

Precedence: `pricing` override → built-in table → conservative default.

---

## `routing`

| Field | Default | Description |
| --- | --- | --- |
| `degrade_at_percent` | 80 | When global monthly spend ≥ this % of cap, degrade model class |
| `class_order` | `[cheap, standard, premium]` | Tier order, **cheapest → most expensive**; degrade steps down one tier in this list |

`class_order` lets you define your own tiers and their degrade order. Every entry
must be a defined `model_class`; classes not listed are treated as un-degradable.

```yaml
routing:
  degrade_at_percent: 80
  class_order: [nano, cheap, standard, premium]   # degrade walks right→left
```

---

## `safety`

| Field | Description |
| --- | --- |
| `preset` | `dev` \| `balanced` \| `strict` \| `custom` |
| `protect.pii` | `mask` \| `block` \| `off` |
| `protect.prompt_injection` | `block` \| `off` |
| `injection_model` | LiteLLM model name for injection classifier |

Feature-level `safety:` overrides the global preset.

Presidio URLs must be set in the environment for PII enforcement. If missing,
the API logs a warning and PII rules are not enforced.

---

## `data_classes` (optional — data-sensitivity governance)

Restrict which model classes / providers may process a given data-sensitivity
class. A feature opts in with `data_sensitivity: <class>`; requests for that
feature are **blocked** (`reasonCode: data_sensitivity_not_permitted`) if the
resolved model class or provider isn't on the allow-list — enforced before
budget gates and on the fallback path too.

```yaml
data_classes:
  restricted:
    allowed_model_classes: [onprem]     # only these classes may run restricted data
    allowed_providers: [ollama]         # and only these providers (by model prefix)

features:
  hr_chat:
    model_class: onprem
    max_tokens: 500
    data_sensitivity: restricted        # gated by the class above
```

| Field | Description |
| --- | --- |
| `allowed_model_classes` | Model classes approved for this sensitivity (omit = no class restriction) |
| `allowed_providers` | Providers approved (matched against the model's provider prefix; omit = no provider restriction) |

A feature may also set `retention_days: <n>` to prune its own `request_logs`
rows on a stricter window than the global `REQUEST_LOG_RETENTION_MS` (applied by
the maintenance sweep). Combine with the erasure endpoint
(`POST /v1/admin/erasure`, permission `data:erase`) for GDPR/CCPA workflows.

Use this to keep confidential/restricted data on approved (e.g. on-prem or
region-pinned) models and off general cloud providers.

---

## `observability`

| Field | Values | Description |
| --- | --- | --- |
| `provider` | `none` \| `langfuse` | Trace sink |

Override at runtime with `OBSERVABILITY_PROVIDER=langfuse` and Langfuse env vars.

---

## Environment variables

See [`.env.example`](../.env.example) and [Operations](./operations.md). Key vars:

| Variable | Purpose |
| --- | --- |
| `MODELGOV_CONFIG` | Path to `modelgov.yaml` |
| `DATABASE_URL` | Postgres connection string |
| `MODELGOV_API_KEY` | Bearer token for apps (or use `MODELGOV_API_KEYS` JSON) |
| `LITELLM_BASE_URL` | LiteLLM proxy URL |
| `LITELLM_MASTER_KEY` | LiteLLM auth |
| `PRESIDIO_ANALYZER_URL` / `PRESIDIO_ANONYMIZER_URL` | PII services |
| `REDIS_URL` | Shared rate limits across API replicas (recommended in production) |
| `IDEMPOTENCY_STALE_MS` | Stale in-flight idempotency claim TTL (default **900000** = 15m) |
| `RESERVATION_STALE_MS` | Orphaned budget reservation release TTL (default **900000** = 15m) |
| `BUDGET_ALERT_WEBHOOK_URL` | POST budget alert once per month when threshold crossed |
| `BUDGET_ALERT_WEBHOOK_SECRET` | Optional HMAC secret for `X-Modelgov-Signature` |
| `POLICY_STORE_ENABLED` | Load the active policy from the DB version store instead of the file (default off) |
| `MULTI_TENANT_POLICY` | Evaluate each request against its tenant's active policy version (needs `POLICY_STORE_ENABLED`; default off) — see [multi-tenancy](./design/multi-tenancy.md) |
| `POLICY_CACHE_TTL_MS` | Per-tenant policy cache TTL; bounds restart-free activation lag (default **30000**) |
| `DB_RLS_ENABLED` | Opt-in Postgres RLS tenant isolation on `config_versions` (requires a non-owner DB role; default off) |

### Scoped API keys (multi-tenant operators)

Use `MODELGOV_API_KEYS` when one deployment serves multiple teams or projects.
Each key is a **principal** with optional scope fields:

| Field | Purpose |
| --- | --- |
| `name` | Label for logs and audit |
| `key` | Bearer secret |
| `projectId` | Pins `projectId` on chat requests; usage queries are tenant-scoped |
| `environment` | Pins `environment` (e.g. `production`) |
| `allowedUserTypes` | Restrict which `userType` values the key may send |
| `allowedUserIds` | Restrict which `userId` values the key may send |
| `permissions` | Default `["chat:create"]`; add `"usage:read"` for ops summaries; add `"requests:read"` for audit log access |

**Key patterns (2026 defaults):**

```json
[
  {
    "name": "ops",
    "key": "replace-long-random",
    "permissions": ["chat:create", "usage:read", "requests:read"]
  },
  {
    "name": "tenant-a-app",
    "key": "replace-long-random",
    "projectId": "tenant-a",
    "environment": "production",
    "allowedUserTypes": ["logged_in"],
    "permissions": ["chat:create"]
  },
  {
    "name": "tenant-a-support",
    "key": "replace-long-random",
    "projectId": "tenant-a",
    "allowedUserIds": ["user_123", "user_456"],
    "permissions": ["chat:create", "usage:read", "requests:read"]
  }
]
```

- **Ops keys** (no `projectId`): full deployment visibility on usage when `usage:read` is granted; optional `?projectId=` targets a tenant partition.
- **Tenant keys** (`projectId` set): must pass `userId` or `feature` on `GET /v1/usage`; global monthly counters are hidden; budget data is read from that project's partition only.
- Default single `MODELGOV_API_KEY` grants `chat:create` only — add `usage:read` explicitly for monitoring.

Set as one-line JSON in `MODELGOV_API_KEYS`.

---

## Validation errors

Unknown `feature`, `user_type`, or `model_class` → HTTP **400** with
`unknown_feature` / similar codes from the policy engine.
