# FastAPI support-chat example

A minimal FastAPI service that routes AI through Modelgov using the **Python
SDK** (`modelgov`). Shows the boundary: the app authenticates/authorizes the
user, then Modelgov enforces AI policy (budget, **token limits**, model access,
safety).

## Run

```bash
pip install -r requirements.txt
pip install -e ../../packages/sdk-python      # the Modelgov Python SDK

export MODELGOV_URL=http://localhost:3000
export MODELGOV_API_KEY=sk-modelgov-api-local   # a key your Modelgov deployment accepts
uvicorn app.main:app --reload
```

Point it at a running Modelgov gateway (see the repo `make up-local` for an
Ollama-only stack, or `npx create-modelgov` to scaffold one).

## Try it

```bash
curl -sX POST localhost:8000/support-chat \
  -H 'content-type: application/json' \
  -d '{"message":"How do I reset my password?"}'
```

- Success → `{ reply, requestId, decision }`.
- Over budget **or** over token limit → `429` with `reasonCode`.
- PII/injection blocked → `400 safety_blocked`.

The gateway's `modelgov.yaml` must register the `support_chat` feature and a
`logged_in` user type.
