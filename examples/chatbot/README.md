# Modelgov Chatbot Demo

A small chatbot that proves the whole project in usage: **every message goes
through Modelgov before the model runs**, and the UI shows what Modelgov decided
for each reply — model, decision (allow/degrade/fallback), tokens in/out, cost,
and the daily budget/token headroom left. Blocks (over budget, over **token
limit**, wrong tier, safety) render as visible bubbles.

It runs fully locally against **Ollama** — no cloud API key. LiteLLM maps the
"cloud" model names in `modelgov.yaml` (`openai/gpt-4o-mini`, …) to local Ollama
models, so Modelgov behaves exactly as it would against a real provider (cost
estimates use the real price table; execution is local).

## Run it (two commands)

**1. Start the gateway** (Postgres + LiteLLM→Ollama + Modelgov API):

```bash
ollama pull llama3.2:1b && ollama pull llama3.2:3b   # once
cd examples/chatbot
./setup                              # prints the gateway URL
```

**2. Start the chatbot UI:**

```bash
cd examples/chatbot
cp .env.example .env
npm install
npm run dev                          # http://localhost:3002
```

(If you already run a gateway another way — e.g. `npx create-modelgov` or
`./setup` — just point `.env`'s `MODELGOV_URL`/`MODELGOV_API_KEY` at it and
skip step 1. The gateway must load this folder's `modelgov.yaml`.)

## Prove it — a 60-second tour

1. **Chat as `anonymous`.** You get real replies from the local model. Each reply
   shows a receipt: `allow · openai/gpt-4o-mini · 31→18 tok · $0.00003 · req_…`.
2. **Send a second message.** `anonymous` hits its **token cap**
   (`daily_tokens: 720`, ~700 estimated per message) → a red bubble: *"Daily
   token limit reached for this tier."* That's Modelgov stopping spend **before**
   the model call.
3. **Pick the `notes_helper` feature while still `anonymous`.** It requires the
   `standard` model class, which `anonymous` isn't allowed → *"This tier isn't
   allowed to use that model class."* (`model_class_not_permitted`).
4. **Switch the tier to `logged_in`.** Higher caps + `standard` access — messages
   flow again, and the budget bar shows more headroom.
5. **Watch the budget bar** update after every reply (remaining USD + tokens).

## What this demonstrates

- The boundary: the app owns the user/tier; Modelgov owns the AI-call policy.
- **Cost *and* token** budgets, enforced per tier, per feature, globally.
- Model-class access control by tier, and degrade/fallback (visible in the badge).
- Per-request audit id (`requestId`) surfaced to the client.

### Run against a real provider (OpenRouter / Azure) instead of Ollama

The demo's `modelgov.yaml` uses generic model names (`openai/gpt-4o-mini`), so
switching providers is just a LiteLLM swap — **no policy change**. In `.env`:

```bash
# OpenRouter
LITELLM_CONFIG=./litellm.openrouter.yaml
OPENROUTER_API_KEY=sk-or-...

# …or Azure OpenAI (edit litellm.azure.yaml to your deployment names)
LITELLM_CONFIG=./litellm.azure.yaml
AZURE_API_KEY=...
AZURE_API_BASE=https://<resource>.openai.azure.com
AZURE_API_VERSION=2024-08-01-preview
```

Then `docker compose up`. Budgets/tokens/limits behave identically. (If you
instead put provider-native model names like `openrouter/…` in `modelgov.yaml`,
add a [`pricing`](../../docs/providers.md) block so USD estimates stay accurate —
`create-modelgov` does this for you.)

### Optional: see safety blocking

Set `support_chat`'s `safety: strict` in `modelgov.yaml` and run the gateway with
Presidio (see the repo's `./setup` / operations docs). Then a message containing
an email or SSN is blocked with a `safety_blocked` bubble.
