# HTTP API

Base URL: your Modelgov API (`./setup` prints the local URL; default `http://localhost:3090`).

OpenAPI spec: **`GET /openapi.json`** (when server is running).

Authentication: **`Authorization: Bearer <API_KEY>`** on all routes except
`/health` and `/ready`.

## Endpoints

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| `GET` | `/health` | — | Liveness (process only) |
| `GET` | `/ready` | — | Readiness (database-gated; dependencies reported) |
| `GET` | `/openapi.json` | — | OpenAPI 3 document |
| `POST` | `/v1/chat` | `chat:create` | Guarded chat completion |
| `POST` | `/v1/explain` | `chat:create` or `policy:explain` | Dry-run policy (no model call) |
| `GET` | `/v1/usage` | `usage:read` | Budget snapshots and recent stats |
| `GET` | `/v1/usage/summary` | `usage:read` | Aggregated cost/request summary |
| `GET` | `/v1/requests` | `requests:read` | List audit records (metadata only) |
| `GET` | `/v1/requests/:id` | `requests:read` | Single audit record |
| `POST` | `/v1/admin/keys` | `keys:admin` | Issue a key (returns secret once) |
| `GET` | `/v1/admin/keys` | `keys:admin` | List keys (metadata only) |
| `GET` | `/v1/admin/keys/:id` | `keys:admin` | Single key record |
| `POST` | `/v1/admin/keys/:id/rotate` | `keys:admin` | New secret; old one invalid immediately |
| `POST` | `/v1/admin/keys/:id/revoke` | `keys:admin` | Revoke (idempotent) |
| `GET` | `/v1/admin/audit` | `audit:read` | Tamper-evident admin audit log |
| `GET` | `/v1/admin/audit/verify` | `audit:read` | Re-walk the hash chain; report integrity |
| `POST` | `/v1/admin/erasure` | `data:erase` | Erase a user's request-linked data (GDPR/CCPA) |
| `GET` | `/v1/admin/policy/versions` | `policy:read` | List stored policy versions |
| `POST` | `/v1/admin/policy/versions` | `policy:write` | Validate + store a new policy version |
| `POST` | `/v1/admin/policy/preview` | `policy:read` | Validate + diff a proposed policy without saving |
| `GET` | `/v1/admin/policy/active` | `policy:read` | Active policy version metadata |
| `GET` | `/v1/admin/policy/versions/:id/diff` | `policy:read` | Diff a stored version against another (`?against=<id>`) or the active one |
| `POST` | `/v1/admin/policy/versions/:id/activate` | `policy:write` | Activate/rollback to a version |

Default API keys include `chat:create` only. Add `usage:read` for the usage endpoint
(see [Configuration](./configuration.md#scoped-api-keys-production)).

---

## `POST /v1/chat`

### Headers

| Header | Required | Description |
| --- | --- | --- |
| `Authorization` | Yes | `Bearer <key>` |
| `Content-Type` | Yes | `application/json` |
| `Idempotency-Key` | No | Max 255 chars; safe retries |

### Body

```json
{
  "userId": "user_123",
  "userType": "logged_in",
  "feature": "support_chat",
  "modelClass": "cheap",
  "messages": [
    { "role": "user", "content": "Hello" }
  ],
  "inputTokensEstimate": 120,
  "temperature": 0.7,
  "stream": false,
  "projectId": "optional",
  "environment": "optional",
  "metadata": {}
}
```

`feature` is **required** and must exist in `modelgov.yaml`.

### Streaming (`stream: true`)

Set `stream: true` to receive the completion incrementally as
`text/event-stream`. All pre-call gates (policy, input safety, budget
reservation) run first: if any fails, you get the **normal JSON error** with its
status code — no stream is opened. Once tokens start flowing the response is a
`200` SSE stream:

```text
data: {"delta":"Hel"}

data: {"delta":"lo"}

data: {"done":true,"model":"openai/gpt-4o-mini","usage":{"inputTokens":5,"outputTokens":2},"requestId":"req_42"}

data: [DONE]
```

Constraints:

- **Output PII protection must be off** for the feature — a streamed token
  can't be masked after it's sent. Features whose resolved plan sets `pii` to
  `mask`/`block` return `400 streaming_unsupported`. (Input PII/injection checks
  still run before the stream.)
- **`Idempotency-Key` is not supported** with streaming (`400`).
- **Hierarchical budgets** (`HIERARCHICAL_BUDGETS=true` with a `budgetNodeId` on the
  body or API key) use the same pre-call pipeline and SSE transport as flat budgets;
  node-path reservations are settled on the terminal frame (or released on disconnect).
- **No mid-stream provider fallback** — a provider failure *before* the first
  token returns `502` (JSON); a failure *after* streaming starts emits an SSE
  `event: error` frame and ends the stream.
- Cost is reserved up front and settled from the terminal usage; a client
  disconnect aborts the upstream call and releases the reservation.

Budget is settled after the stream completes; the terminal frame carries the
`requestId` for the audit record.

### Success `200`

```json
{
  "message": { "role": "assistant", "content": "..." },
  "model": "openai/gpt-4o-mini",
  "provider": "openai",
  "decision": "allow",
  "usage": { "inputTokens": 12, "outputTokens": 8 },
  "cost": { "estimatedUsd": 0.0001, "actualUsd": 0.00008 },
  "budgetRemaining": {
    "userDailyUsd": 0.24,
    "featureMonthlyUsd": null,
    "globalMonthlyUsd": 499.5
  },
  "safety": { "piiMasked": false, "injectionBlocked": false },
  "requestId": "req_42"
}
```

`provider` is the provider of the model that actually ran (matches `model`,
including on a fallback) — no need to parse the model string. `decision` is
`allow` / `degrade` / `fallback`.

Response header: `x-modelgov-request-id: req_42` (same value as `requestId`).

`metadata` in the request body is stored on the audit log for operator search.
It does **not** affect policy unless you add explicit rules later. Max 32 keys.

### Request correlation

| Field / header | When | Format | Use |
| --- | --- | --- | --- |
| `requestId` (body) | Success `200` | `req_<n>` | `modelgov requests show req_<n>` |
| `error.details.auditRequestId` | Policy/safety blocks | `req_<n>` | Same audit lookup |
| `error.requestId` | All errors | UUID | HTTP trace id |
| `x-modelgov-request-id` | Success + many errors | `req_<n>` | Log in your app |

Log both your domain id and `requestId` / `auditRequestId` for support workflows.
See [Integration debugging runbook](./runbooks/integration-debugging.md).

### Error envelope

Every error uses the same top-level envelope. Policy and budget block metadata
is stable inside `error.details`:

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
    "requestId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

`details.auditRequestId` is the audit log row (`modelgov requests show`).
`requestId` is the HTTP trace id (UUID).

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Bad body / unknown feature |
| 401 | `unauthorized` | Missing or invalid API key |
| 403 | `policy_blocked` | Policy engine blocked |
| 403 | `budget_exceeded` | Atomic reservation failed |
| 403 | `safety_blocked` | PII or injection |
| 403 | `forbidden` | Key lacks permission or scope |
| 409 | `idempotency_in_progress` | Same key, request still running |
| 422 | `idempotency_key_reuse` | Same key, different body |
| 502 | `provider_unavailable` | LiteLLM / provider down |
| 503 | `safety_unavailable` | Presidio / safety backend down |

---

## `POST /v1/explain`

Dry-run policy evaluation. Returns the decision, resolved model, safety plan,
and live budget snapshot **without** calling LiteLLM or reserving budget.

Use this to answer: *why would this request block, degrade, or use this model?*

### Body

Same identity fields as `/v1/chat`, but **no `messages`**:

```json
{
  "userId": "user_123",
  "userType": "logged_in",
  "feature": "support_chat",
  "modelClass": "premium"
}
```

### Success `200`

```json
{
  "decision": "block",
  "reason": "model_class 'premium' is not permitted for user_type 'logged_in'",
  "requested": { "userId": "user_123", "userType": "logged_in", "feature": "support_chat", "modelClass": "premium" },
  "resolved": { "modelClass": "premium", "model": "openai/gpt-5", "provider": "openai" },
  "safety": { "preset": "strict", "pii": "block", "promptInjection": "block", "maxOutputTokens": 500 },
  "cost": { "estimatedUsd": 0.0012 },
  "budget": {
    "remaining": { "userDailyUsd": 0.24, "featureMonthlyUsd": null, "globalMonthlyUsd": 499.5 },
    "used": { "userDailyUsd": 0.01, "userDailyRequests": 3, "featureMonthlyUsd": 0.02, "globalMonthlyUsd": 0.5 },
    "permittedModels": ["cheap", "standard"],
    "dailyRequestLimit": 50,
    "dailyRequestsRemaining": 47
  },
  "wouldCallModel": false,
  "summary": "Decision: block\nReason: ..."
}
```

CLI equivalent:

```bash
modelgov explain --userType logged_in --feature support_chat --modelClass premium
```

---

## `GET /v1/usage`

Query budget counters and recent request stats (operator dashboard / debugging).

### Query parameters

| Param | Required | Description |
| --- | --- | --- |
| `userId` | No | Filter user daily counters |
| `feature` | No | Filter feature monthly counters |

### Example

```bash
curl -s "$MODELGOV_URL/v1/usage?userId=user_123" \
  -H "Authorization: Bearer $MODELGOV_API_KEY" | jq .
```

Requires API key with `usage:read` permission.

---

## `GET /v1/usage/summary`

Aggregated stats from `request_logs` for operator visibility.

| Param | Description |
| --- | --- |
| `feature` | Filter to one feature |
| `userType` | Filter to one user type |
| `since` | `24h`, `7d`, or ISO-8601 (default `24h`) |

```bash
curl -s "$MODELGOV_URL/v1/usage/summary?feature=support_chat&since=7d" \
  -H "Authorization: Bearer $OPS_KEY" | jq .
```

CLI: `modelgov usage summary --feature support_chat --since 7d`

---

## `GET /v1/requests`

List audit records. **Metadata only** — prompts and completions are not stored in
`request_logs`. Optional Langfuse content requires separate observability access.

| Param | Description |
| --- | --- |
| `userId` | Filter by user |
| `feature` | Filter by feature |
| `userType` | Filter by user type |
| `status` | `completed`, `blocked`, `safety_blocked`, `error` |
| `reasonCode` | Stable block reason (e.g. `daily_budget_exceeded`) |
| `since` | `24h`, `7d`, or ISO-8601 |
| `limit` | Max rows (default 50, max 100) |

Requires `requests:read`. Future `requests:read_content` is reserved for explicit
content replay when enabled.

### `GET /v1/requests/:id`

Returns one record. IDs are `req_<number>` (database primary key).

Each record includes `provider` (e.g. `openai`, `openrouter`, `azure`, `ollama`)
— the provider of the model that ran, derived the same way as the live chat
response's `provider`, so historical logs and live responses agree. It's absent
for requests blocked before a model was selected. Records also carry
`resolvedModelClass`, `model`, cost, tokens, `reasonCode`, safety flags, and
(when the policy store is used) `policy.configHash` / `policy.policyVersion`.

```bash
curl -s "$MODELGOV_URL/v1/requests/req_123" -H "Authorization: Bearer $OPS_KEY" | jq .
```

CLI: `modelgov requests show req_123`

---

## Idempotency

1. First request with `Idempotency-Key: abc` runs normally.
2. Retry with same key + same body → `200` replay, `x-idempotent-replay: true`.
3. Same key + different body → `422 idempotency_key_reuse`.
4. Concurrent duplicate → one wins; other gets `409` or replay when complete.

Keys are scoped per **`userId`** (composite `(user_id, key)`).

---

## Rate limiting

Default: 120 requests / minute / IP (configurable via `RATE_LIMIT_MAX` and
`RATE_LIMIT_WINDOW_MS`).

| Mode | Behavior |
| --- | --- |
| No `REDIS_URL` | In-memory per API instance (dev / single replica) |
| `REDIS_URL` set | Shared counter across replicas (production compose includes Redis) |

`/health` and `/ready` are excluded from rate limits.

---

## Admin: API keys

DB-backed key lifecycle. All routes require the `keys:admin` permission — seed one
bootstrap key with it via `MODELGOV_API_KEYS`, then manage the rest here. Only the
SHA-256 hash of each secret is stored; the plaintext `secret` is returned **once**
on create/rotate and never again.

### `POST /v1/admin/keys`

```json
{
  "name": "checkout-svc",
  "permissions": ["chat:create"],
  "projectId": "checkout",
  "environment": "production",
  "expiresAt": "2027-01-01T00:00:00Z"
}
```

`201` returns the key record plus a one-time `secret`:

```json
{
  "id": "b0c1…",
  "name": "checkout-svc",
  "keyPrefix": "sk-modelgov-a1b2c3",
  "permissions": ["chat:create"],
  "projectId": "checkout",
  "createdAt": "2026-06-30T12:00:00Z",
  "secret": "sk-modelgov-…"
}
```

### `GET /v1/admin/keys`

Lists key metadata (never secrets or hashes). Query: `includeRevoked=true`,
`projectId=<id>`.

### `POST /v1/admin/keys/:id/rotate`

Mints a new `secret` for the same key id; the previous secret is rejected
immediately. `404` if the id is unknown or already revoked.

### `POST /v1/admin/keys/:id/revoke`

Revokes the key (idempotent) → `{ "id": "…", "revoked": true }`. Takes effect
across replicas within `API_KEY_CACHE_TTL_MS` (default 10s), or immediately on the
replica that handled the revoke.
