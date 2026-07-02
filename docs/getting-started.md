# Getting started

Get from zero to a guarded LLM call in under 5 minutes once Docker is running.

## Fastest path — scaffold a project

```bash
npx create-ai-guard my-app
```

> Note: the packages (`create-ai-guard`, `@ai-guard/sdk`, `ai-guard-sdk`) are not
> yet published to npm/PyPI. Until then, run from source — see
> [self-host.md](./self-host.md).

The wizard asks four things — **framework**, **AI feature (template)**,
**provider**, and your **API key** — then generates everything you need:

```text
ai-guard.yaml   docker-compose.yml   litellm_config.yaml   .env
scripts/smoke.mjs   + an example route & SDK client for your framework
```

Non-interactive (CI/scripts):

```bash
npx create-ai-guard my-app --template support_chat --framework nextjs --provider openai --yes
cd my-app
# set your provider key in .env, set the api image in docker-compose.yml
docker compose up -d
node scripts/smoke.mjs        # → prints a requestId on the first guarded call
```

**Templates:** `support_chat`, `document_extraction`, `admin_assistant`,
`saas_tiers`, `event_intake`, `local_dev` (Ollama, no cloud key),
`general_gateway`.
**Frameworks:** `nextjs`, `express`, `fastify`, `fastapi`, `none`.

The rest of this guide runs the gateway from the repo directly.

## Prerequisites

- Docker and Docker Compose
- Node.js 20+ and pnpm (for the SDK example and wizard)
- At least one provider API key (OpenAI and/or Anthropic), **or** [Ollama](./operations.md#local-ollama) for fully local mode

## Step 1 — Start the stack

From the Ai-Guard repo root:

```bash
make setup
```

If `.env` does not exist, setup copies `.env.example` → `.env`. Edit `.env`:

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
AI_GUARD_API_KEY=sk-ai-guard-api-local   # any secret; apps use this to call the API
```

Run again:

```bash
make setup
```

Setup starts the stack, waits for `/ready`, runs an authenticated smoke request,
and prints the API URL. The API listens at **http://localhost:3000**.

Optional: `make up-full` adds Langfuse at http://localhost:3001 (`admin@example.com` / `ai-guard-admin`).
For local Ollama mode, run `make up-local`.

## Step 2 — Understand policy (optional)

Policy lives in [`ai-guard.yaml`](../ai-guard.yaml). Out of the box you get:

- **Features:** `support_chat`, `notes_helper`
- **User types:** `anonymous`, `logged_in`, `admin` (each with different budgets)
- **Model classes:** `cheap`, `standard`, `premium` (primary + fallback models)

See [Configuration](./configuration.md) to customize.

## Step 3 — Call from your app

### TypeScript SDK

```typescript
import { createAiGuardClient } from "@ai-guard/sdk";

const ai = createAiGuardClient({
  baseUrl: "http://localhost:3000",
  apiKey: process.env.AI_GUARD_API_KEY!,
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

Every call **must** include `feature` (registered in `ai-guard.yaml`) and
`userType` (drives budget limits).

Details: [TypeScript SDK](./sdk-typescript.md).

### curl

```bash
curl -s http://localhost:3000/v1/chat \
  -H "Authorization: Bearer sk-ai-guard-api-local" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-42",
    "userType": "logged_in",
    "feature": "support_chat",
    "messages": [{"role": "user", "content": "Hello"}]
  }' | jq .
```

## Step 4 — Run the included example

```bash
pnpm install && pnpm build
AI_GUARD_API_KEY=sk-ai-guard-api-local \
  pnpm --filter support-chat-example start "How do I reset my password?"
```

See [`examples/support_chat/README.md`](../examples/support_chat/README.md) for
budget blocks, PII, and injection demos.

## Step 5 — Scaffold a new project

```bash
pnpm exec create-ai-guard ./my-app
cd my-app
# edit ai-guard.yaml and .env, then run from an Ai-Guard deployment:
ai-guard validate --config ai-guard.yaml
```

## Authorization boundary

**Your app** authenticates users and checks product permissions (can this user
edit this record?).

**Ai-Guard** enforces AI policy only: budgets, safety, model access, logging.

Call Ai-Guard only after your app has authorized the action. See
[Architecture — authorization boundary](./ARCHITECTURE.md#what-ai-guard-owns-vs-what-your-app-owns).

## Health checks

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | No | Liveness; process is up |
| `GET /ready` | No | Readiness; database gates traffic, other dependencies are reported |

## What's next

- [Configuration](./configuration.md) — tune budgets and features
- [Operations](./operations.md) — production deploy
- [HTTP API](./api.md) — errors, idempotency, usage endpoint
