# Modelgov Python SDK

Package: `modelgov` (module `modelgov`). The Python counterpart to
[`@modelgov/sdk`](../sdk-typescript).

The SDK is a **thin HTTP client** to the Modelgov API. Policy enforcement is
always server-side. Every request declares a **user**, **user type**, and
**feature**; policy is checked **before** the model call.

## Install

```bash
pip install modelgov
```

Published on PyPI as `modelgov` (>= 1.1.0). To develop against local SDK
changes, install from source instead (see also [self-host.md](../../docs/self-host.md)).

From the monorepo (editable, with test deps):

```bash
pip install -e "packages/sdk-python[dev]"
```

Requires Python >= 3.9. Depends on [`httpx`](https://www.python-httpx.org/).

## Create a client

```python
import os
from modelgov import ModelgovClient

ai = ModelgovClient(
    base_url=os.environ.get("MODELGOV_URL", "http://localhost:3000"),
    api_key=os.environ["MODELGOV_API_KEY"],
)
```

`ModelgovClient` is a context manager and closes its connection pool on exit:

```python
with ModelgovClient(base_url=..., api_key=...) as ai:
    ...
```

## Chat

```python
res = ai.chat(
    user_id="user_123",        # your end-user id
    user_type="logged_in",     # must match modelgov.yaml budgets
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

### Vision (multimodal)

Pass content parts instead of a string to send images to a vision model. The
gateway governs budget/audit and still runs safety on the text parts:

```python
res = ai.chat(
    user_id="user_123",
    user_type="logged_in",
    feature="document_extraction",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "Extract the total from this receipt."},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}},
        ],
    }],
)
```

### Grounding

For a feature with safety `grounding: strict`, pass retrieved passages as
`context`. The gateway answers only from them, forces verbatim citations, and
verifies them — unverifiable answers become a safe refusal, and
`res["safety"]["grounded"]` reports whether the citations checked out:

```python
res = ai.chat(
    user_id="user_123",
    user_type="logged_in",
    feature="grounded_support",
    messages=[{"role": "user", "content": "How long do refunds take?"}],
    context=["Refunds are issued within 5 business days of approval."],
)
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

## Embeddings

`embed()` runs governed embeddings (`POST /v1/embeddings`) — policy-checked,
budget-reserved, and audited like `chat()`. Pass one string or a batch:

```python
res = ai.embed(
    user_id="user_123",
    user_type="logged_in",
    feature="rag_ingest",
    input=["first passage", "second passage"],   # or a single string
)
vectors = res["embeddings"]   # one vector per input, in request order
```

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

# Per-transaction cost rollup (grouped by correlationId), top-N by cost, with
# LLM vs externally-ingested cost broken out:
txns = ai.get_usage_transactions(since="7d", limit=50)
for t in txns["transactions"]:
    print(t["correlationId"], t["actualCostUsd"], t["llmCostUsd"], t["externalCostUsd"])

# Per-provider/model health from the LiteLLM proxy (read-only operator view):
health = ai.get_provider_health()
print(health["status"])   # "ok" | "degraded" | "fail" | "skipped"
for m in health["models"]:
    print(m["provider"], m["model"], m["healthy"], m.get("error"))
```

## Correlating related calls

The gateway groups audit rows and cost by `x-request-id`. Pass the same
`request_id` to every call that belongs to one user action — e.g. a document
extraction feeding a chat answer — so they roll up as a single transaction in
`get_usage_transactions()`:

```python
rid = f"txn-{user_id}-{session_id}"   # any stable id, <= 128 chars
doc = ai.extract_document(
    user_id="user_123", user_type="logged_in", feature="doc_review",
    provider="azure-di", document={"url": scan_url}, request_id=rid,
)
answer = ai.chat(
    user_id="user_123", user_type="logged_in", feature="support_chat",
    messages=[{"role": "user", "content": doc["text"]}], request_id=rid,
)
```

`request_id` is accepted by `chat`, `chat_stream`, `embed`, `explain`, and
`extract_document`. Omit it to let the gateway mint a per-request UUID. The id
is echoed back on the `x-modelgov-request-id` response header.

## Errors

| Class | When |
| --- | --- |
| `PolicyBlockedError` | 403 `policy_blocked` or `budget_exceeded` |
| `SafetyBlockedError` | 403 `safety_blocked` (PII or prompt injection) |
| `ModelgovError` | Other 4xx / 5xx |

`PolicyBlockedError` and `SafetyBlockedError` subclass `ModelgovError`. Each
error carries the API's structured envelope:

```python
from modelgov import ModelgovError, PolicyBlockedError, SafetyBlockedError

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
    print(err.audit_request_id)  # "req_<n>" — modelgov requests show
    print(err.request_id)        # HTTP trace id (UUID)
    print(err.body)              # full parsed envelope
except ModelgovError as err:
    ...
```

## Integration pattern

```text
1. Authenticate user (your app)
2. Authorize product action (your app)
3. ai.chat(user_id=..., user_type=..., feature=..., messages=...)
4. Return res["message"]["content"] to the user
```

Never call Modelgov before your app has decided the user may use this feature.

## Development

```bash
pip install -e "packages/sdk-python[dev]"
cd packages/sdk-python
pytest
```
