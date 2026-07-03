# Next.js support chat integration

Shows a **real app boundary**: Next.js API route authenticates the user,
checks product permissions, then calls Modelgov for the AI policy layer.

```text
Browser → POST /api/support → session auth (your app)
                          → Modelgov SDK (policy + model)
                          → JSON response
```

Modelgov does **not** replace your auth. This example uses a fake session cookie
for demonstration.

## Prerequisites

- Modelgov stack running (`./setup` from repo root)
- Node.js 20+

## Setup

```bash
cd examples/nextjs_support_chat
cp .env.example .env.local
# Set MODELGOV_API_KEY, MODELGOV_URL
pnpm install
pnpm dev
```

## Try it

```bash
# Logged-in user (allowed)
curl -s -X POST http://localhost:3001/api/support \
  -H 'content-type: application/json' \
  -H 'cookie: demo_session=logged_in' \
  -d '{"message":"How do I reset my password?"}' | jq .

# Anonymous user (tight budget — may block after a few calls)
curl -s -X POST http://localhost:3001/api/support \
  -H 'content-type: application/json' \
  -H 'cookie: demo_session=anonymous' \
  -d '{"message":"help"}' | jq .
```

## Key files

| File | Role |
| --- | --- |
| `lib/session.ts` | **Your app** — who is the user? |
| `lib/modelgov.ts` | Modelgov client singleton |
| `app/api/support/route.ts` | Auth check → `ai.chat()` → handle blocks |

## Policy block handling

When Modelgov blocks a request, the API route maps `PolicyBlockedError` to a
`402`-style JSON response with the stable `reasonCode` so the UI can show an
upgrade message or retry hint.

See [Failure semantics](../../docs/failure-semantics.md) for the full error contract.
