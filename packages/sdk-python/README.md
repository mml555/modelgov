# Ai-Guard Python SDK

Package: `ai-guard-sdk` (module `ai_guard`). The Python counterpart to
[`@ai-guard/sdk`](../sdk-typescript).

The SDK is a **thin HTTP client** to the Ai-Guard API. Policy enforcement is
always server-side. Every request declares a **user**, **user type**, and
**feature**; policy is checked **before** the model call.

## Install

```bash
pip install ai-guard-sdk
```

> Note: `ai-guard-sdk` is not yet published to PyPI. Until then, install from
> source with the editable install below (see also [self-host.md](../../docs/self-host.md)).

From the monorepo (editable, with test deps):

```bash
pip install -e "packages/sdk-python[dev]"
```

Requires Python >= 3.9. Depends on [`httpx`](https://www.python-httpx.org/).

## Create a client

```python
import os
from ai_guard import AiGuardClient

ai = AiGuardClient(
    base_url=os.environ.get("AI_GUARD_URL", "http://localhost:3000"),
    api_key=os.environ["AI_GUARD_API_KEY"],
)
```

`AiGuardClient` is a context manager and closes its connection pool on exit:

```python
with AiGuardClient(base_url=..., api_key=...) as ai:
    ...
```

## Chat

```python
res = ai.chat(
    user_id="user_123",        # your end-user id
    user_type="logged_in",     # must match ai-guard.yaml budgets
    feature="support_chat",    # required — registered feature
    model_class="cheap",
    messages=[{"role": "user", "content": "Help me reset my password"}],
    # optional:
    # input_tokens_estimate=120,
    # temperature=0.7,
    # project_id="checkout",
    # environment="production",
    # metadata={"trace_id": "abc"},
)

print(res["message"]["content"])
print(res["model"], res["decision"], res["requestId"])
```

Snake_case keyword args are converted to the camelCase JSON the API expects
(`user_id` → `userId`, `model_class` → `modelClass`, etc.). `None`-valued
optional args are omitted from the request body.

### Response

`chat()` returns a `ChatResponse` (a `TypedDict`), so it is a plain `dict` with
typed keys:

```python
{
  "message": {"role": "assistant", "content": "..."},
  "model": "openai/gpt-4o-mini",
  "decision": "allow",             # "allow" | "degrade" | "fallback"
  "usage": {"inputTokens": 12, "outputTokens": 8},
  "cost": {"estimatedUsd": 0.0001, "actualUsd": 0.00008},
  "budgetRemaining": {"userDailyUsd": 0.24, "featureMonthlyUsd": None, "globalMonthlyUsd": 499.5},
  "safety": {"piiMasked": False, "injectionBlocked": False},
  "requestId": "req_42",           # audit id — log with your domain ids
}
```

## Streaming

`chat_stream()` yields incremental text chunks over Server-Sent Events. It
sends `"stream": true` and iterates `data:` lines until the `[DONE]` sentinel.

```python
for chunk in ai.chat_stream(
    user_id="user_123",
    user_type="logged_in",
    feature="support_chat",
    messages=[{"role": "user", "content": "Write a haiku about budgets"}],
):
    print(chunk, end="", flush=True)
```

**SSE framing assumption:** OpenAI-style events — one JSON payload per `data:`
line, terminated by `data: [DONE]`. Text is read from
`choices[0].delta.content` (or a simpler `delta` / `content` / `text` field).
Non-JSON `data:` payloads are yielded verbatim. See the `chat_stream` docstring
if the server's framing differs.

The generator holds the connection open until fully consumed. Policy/safety
blocks that occur before the stream begins raise the usual typed errors.

## Idempotency

Pass a stable key to retry safely without double-charging budget or re-calling
the model:

```python
ai.chat(
    user_id="user_123",
    user_type="logged_in",
    feature="support_chat",
    messages=[{"role": "user", "content": "..."}],
    idempotency_key=f"chat-{user_id}-{session_id}",
)
```

The API returns `x-idempotent-replay: true` on cache hits; a same-key request
with a different body returns `422 idempotency_key_reuse`.

## Explain (dry run)

Evaluate policy without calling the model or reserving budget:

```python
plan = ai.explain(
    user_id="user_123",
    user_type="logged_in",
    feature="support_chat",
    model_class="premium",
)
print(plan["decision"], plan["summary"])
```

## Usage

Requires an API key with `usage:read`.

```python
usage = ai.get_usage(user_id="user_123")
summary = ai.get_usage_summary(feature="support_chat", since="7d")
```

## Errors

| Class | When |
| --- | --- |
| `PolicyBlockedError` | 403 `policy_blocked` or `budget_exceeded` |
| `SafetyBlockedError` | 403 `safety_blocked` (PII or prompt injection) |
| `AiGuardError` | Other 4xx / 5xx |

`PolicyBlockedError` and `SafetyBlockedError` subclass `AiGuardError`. Each
error carries the API's structured envelope:

```python
from ai_guard import AiGuardError, PolicyBlockedError, SafetyBlockedError

try:
    ai.chat(
        user_id="user_123",
        user_type="logged_in",
        feature="support_chat",
        messages=[{"role": "user", "content": "..."}],
    )
except PolicyBlockedError as err:
    print(err.status)            # 403
    print(err.code)              # "policy_blocked" | "budget_exceeded"
    print(err.message)           # human-readable
    print(err.details)           # error.details object
    print(err.audit_request_id)  # "req_<n>" — ai-guard requests show
    print(err.request_id)        # HTTP trace id (UUID)
    print(err.body)              # full parsed envelope
except AiGuardError as err:
    ...
```

## Integration pattern

```text
1. Authenticate user (your app)
2. Authorize product action (your app)
3. ai.chat(user_id=..., user_type=..., feature=..., messages=...)
4. Return res["message"]["content"] to the user
```

Never call Ai-Guard before your app has decided the user may use this feature.

## Development

```bash
pip install -e "packages/sdk-python[dev]"
cd packages/sdk-python
pytest
```
