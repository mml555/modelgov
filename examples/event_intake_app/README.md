# Event intake app (Jewgo-style)

Demonstrates a **real product workflow** — not chat — with a clear boundary:

```text
Jewgo verifies admin can create drafts  →  your app auth
Ai-Guard verifies AI extraction call    →  AI policy
```

## Flow

```text
Admin uploads flyer text
  → POST /events/intake (this app)
  → auth check (Bearer admin token)
  → Ai-Guard feature=event_flyer_extraction
  → structured JSON extraction
  → draft created response + aiGuard.requestId
```

## Setup

```bash
export AI_GUARD_CONFIG=examples/event_intake_app/ai-guard.yaml
make up

cd examples/event_intake_app
cp .env.example .env
pnpm install
pnpm start
```

## Try it

```bash
curl -s -X POST http://localhost:3010/events/intake \
  -H 'authorization: Bearer dev-admin-token' \
  -H 'content-type: application/json' \
  -d '{
    "flyerText": "Shabbat Dinner — Friday June 12, 7pm at Chabad Miami. RSVP required.",
    "city": "miami",
    "eventDraftId": "draft_evt_456"
  }' | jq .
```

Response includes `aiGuard.requestId` (e.g. `req_123`). Debug with:

```bash
ai-guard requests show req_123
```

## Correlation logging

The server logs:

```text
jewgo_event_draft=draft_evt_456 ai_guard_request_id=req_123 decision=allow
```

Store both IDs in your product database for support workflows.

## Policy

See [`ai-guard.yaml`](./ai-guard.yaml):

- Feature `event_flyer_extraction` — standard model, balanced safety
- Admin user type — 5 extractions/day, standard model only

## Related

- [Real app integration pattern](../../docs/integrations/real-app-pattern.md)
- [Integration debugging runbook](../../docs/runbooks/integration-debugging.md)
