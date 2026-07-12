# Getting started

Get from zero to a guarded LLM call with one command once Docker is running.

## One-command repo setup

```bash
./setup
```

`./setup` checks Docker, Docker Compose, Node, and pnpm; creates `.env` from
`.env.local.example`; starts the local Docker stack; waits for `/ready`; and
runs an authenticated `/v1/chat` smoke test. The default stack uses the built-in
demo LLM provider, so it does not need OpenAI, Anthropic, Ollama, or Langfuse.
It also writes `MODELGOV_URL` and `MODELGOV_PUBLIC_PORT` to `.env`.

## Prerequisites

- Docker and Docker Compose
- Node.js 20+ with Corepack

If either tool is missing, `./setup` stops with the exact fix to apply.

## Daily commands

| Command | What it does |
| --- | --- |
| `./setup` | First run or repair: config, start, readiness wait, smoke test |
| `make status` | Containers plus `/health` and `/ready` |
| `make stop` | Stop the default local stack |
| `make start` | Start the default local stack again |

The API URL is printed at the end of setup. By default it uses the first free
port in `3090-3099`.

Successful setup ends with:

```text
ok smoke chat succeeded
API:    http://localhost:3090
Status: make status
Stop:   make stop
```

## Understand policy (optional)

Policy lives in [`modelgov.yaml`](../modelgov.yaml). Out of the box you get:

- **Features:** `support_chat`, `notes_helper`
- **User types:** `anonymous`, `logged_in`, `admin` (each with different budgets)
- **Model classes:** `cheap`, `standard`, `premium` (primary + fallback models)

See [Configuration](./configuration.md) to customize.

## Call from your app

### TypeScript SDK

```typescript
import { createModelgovClient } from "@modelgov/sdk";

const ai = createModelgovClient({
  baseUrl: process.env.MODELGOV_URL!,
  apiKey: process.env.MODELGOV_API_KEY!,
});

const res = await ai.chat({
  userId: "user-42",
  userType: "logged_in",
  feature: "support_chat",
  modelClass: "cheap",
  messages: [{ role: "user", content: "How do I reset my password?" }],
});

console.log(res.message.content);
console.log("Cost:", res.cost.actualUsd, "Budget left:", res.budgetRemaining);
```

Every call **must** include `feature` (registered in `modelgov.yaml`) and
`userType` (drives budget limits).

Details: [TypeScript SDK](./sdk-typescript.md).

### curl

```bash
curl -s "$MODELGOV_URL/v1/chat" \
  -H "Authorization: Bearer sk-modelgov-api-local" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-42",
    "userType": "logged_in",
    "feature": "support_chat",
    "messages": [{"role": "user", "content": "Hello"}]
  }' | jq .
```

## Run the included example

```bash
MODELGOV_API_KEY=sk-modelgov-api-local \
  pnpm --filter support-chat-example start "How do I reset my password?"
```

See [`examples/support_chat/README.md`](../examples/support_chat/README.md) for
budget blocks, PII, and injection demos.

## Connect real providers

The default stack proves the gateway locally with the built-in demo provider.

For **any of the 14+ providers**, the easiest path is the console `/setup` wizard
(the link `./setup` prints): pick **Quick start** (OpenAI preset) or
**Customize** → your provider, paste the key, and it writes
`litellm_config.generated.yaml`, saves the key to `.env`, and restarts the model
proxy in place — real calls go live immediately. If the wizard couldn't
auto-restart (no Docker socket), run `pnpm modelgov reload-providers` afterward.

The manual `make start-cloud` path is a legacy alternative whose static
`litellm_config.cloud.yaml` only defines OpenAI and Anthropic models (running it
after the wizard discards the generated config and breaks other providers):

```bash
cp .env.example .env
# set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env
make start-cloud
```

`make start-local` uses Ollama instead. `make start-full` adds Langfuse.
Production setup stays in [Operations](./operations.md) and
[Production deploy](./production-deploy.md).

## Scaffold a new project

```bash
pnpm exec create-modelgov ./my-app
cd my-app
# edit modelgov.yaml and .env, then run from an Modelgov deployment:
modelgov validate --config modelgov.yaml
```

## Authorization boundary

**Your app** authenticates users and checks product permissions (can this user
edit this record?).

**Modelgov** enforces AI policy only: budgets, safety, model access, logging.

Call Modelgov only after your app has authorized the action. See
[Architecture — authorization boundary](./ARCHITECTURE.md#what-modelgov-owns-vs-what-your-app-owns).

## Health checks

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | No | Liveness; process is up |
| `GET /ready` | No | Readiness; database gates traffic, other dependencies are reported |

## What's next

- [Configuration](./configuration.md) — tune budgets and features
- [Operations](./operations.md) — production deploy
- [HTTP API](./api.md) — errors, idempotency, usage endpoint
