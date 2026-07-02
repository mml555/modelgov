# FastAPI support-chat example

A minimal FastAPI service that routes AI through Ai-Guard using the **Python
SDK** (`ai-guard-sdk`). Shows the boundary: the app authenticates/authorizes the
user, then Ai-Guard enforces AI policy (budget, **token limits**, model access,
safety).

## Run

```bash
pip install -r requirements.txt
pip install -e ../../packages/sdk-python      # the Ai-Guard Python SDK

export AI_GUARD_URL=http://localhost:3000
export AI_GUARD_API_KEY=sk-ai-guard-api-local   # a key your Ai-Guard deployment accepts
uvicorn app.main:app --reload
```

Point it at a running Ai-Guard gateway (see the repo `make up-local` for an
Ollama-only stack, or `npx create-ai-guard` to scaffold one).

## Try it

```bash
curl -sX POST localhost:8000/support-chat \
  -H 'content-type: application/json' \
  -d '{"message":"How do I reset my password?"}'
```

- Success → `{ reply, requestId, decision }`.
- Over budget **or** over token limit → `429` with `reasonCode`.
- PII/injection blocked → `400 safety_blocked`.

The gateway's `ai-guard.yaml` must register the `support_chat` feature and a
`logged_in` user type.
