# Event intake app (Jewgo-style)

Demonstrates a **real product workflow** — not chat — with a clear boundary:

```text
Jewgo verifies admin can create drafts  →  your app auth
Modelgov verifies AI extraction call    →  AI policy
```

## Flow

```text
Admin uploads flyer text
  → POST /events/intake (this app)
  → auth check (Bearer admin token)
  → Modelgov feature=event_flyer_extraction
  → structured JSON extraction
  → draft created response + aiGuard.requestId
```

## Setup

```bash
export MODELGOV_CONFIG=examples/event_intake_app/modelgov.yaml
./setup

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
modelgov requests show req_123
```

## Correlation logging

The server logs:

```text
jewgo_event_draft=draft_evt_456 modelgov_request_id=req_123 decision=allow
```

Store both IDs in your product database for support workflows.

## Policy

See [`modelgov.yaml`](./modelgov.yaml):

- Feature `event_flyer_extraction` — standard model, balanced safety
- Admin user type — 5 extractions/day, standard model only

## Related

- [Real app integration pattern](../../docs/integrations/real-app-pattern.md)
- [Integration debugging runbook](../../docs/runbooks/integration-debugging.md)
