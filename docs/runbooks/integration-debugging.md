# Integration debugging runbook

Use this when a user reports **"the AI part failed"** in an app integrated with
Modelgov.

## Symptoms

- Event draft not created after flyer upload
- Support message not sent
- UI shows "AI policy blocked" or generic upstream error
- Unexpected model or cost

## Prerequisites

- Modelgov API reachable from your workstation or bastion
- API key with `requests:read` and `usage:read` (or use CLI with same key)
- Host app logs that include **both** domain ids and Modelgov ids

## Flow

```text
User report
  → find host app request / entity id
  → find modelgov_request_id in app logs
  → modelgov requests show <id>
  → check decision, reason, model, cost
  → modelgov usage summary if pattern-wide
  → resolve (policy, budget, safety, or app bug)
```

## Step 1 — Get the host app context

From the user or your app logs, collect:

| Field | Example |
| --- | --- |
| User id | `admin_42` |
| Feature | `event_flyer_extraction` |
| Domain entity | `draft_evt_456` |
| Timestamp | `2026-06-30T14:22:00Z` |

Search application logs for the correlation line your integration should emit:

```text
job_id=job_456 modelgov_request_id=req_123 decision=allow
```

If `modelgov_request_id` is missing, the app may have failed before calling
Modelgov (auth, validation) or is not logging correlation ids yet — fix the
integration per [real app pattern](../integrations/real-app-pattern.md).

## Step 2 — Inspect the Modelgov request

```bash
export MODELGOV_URL=https://modelgov.internal
export MODELGOV_API_KEY=...

modelgov requests show req_123
```

Check:

| Field | What to look for |
| --- | --- |
| `status` | `ok`, `blocked`, `safety_blocked`, `failed` |
| `decision` | `allow`, `block`, `degrade`, `fallback` |
| `reasonCode` | Stable code for policy blocks |
| `feature` / `userType` | Matches what the app intended |
| `requestedModelClass` vs `modelClass` | Upgrade/downgrade routing |
| `resolvedModel` | Which provider model actually ran |
| `cost.actualUsd` | Spikes vs estimate |
| `metadata` | Host app context (`eventDraftId`, `city`, …) |

List recent requests when you only have user + time:

```bash
modelgov requests list --userId admin_42 --since 1h
```

Or via HTTP:

```bash
curl -s "$MODELGOV_URL/v1/requests?userId=admin_42&limit=20" \
  -H "authorization: Bearer $MODELGOV_API_KEY" | jq .
```

## Step 3 — Classify the failure

### Policy blocked (`status: blocked`, HTTP 403)

Common `reasonCode` values:

| Code | Meaning | Typical fix |
| --- | --- | --- |
| `daily_budget_exceeded` | User daily USD cap | Raise cap or wait for reset |
| `daily_request_limit_reached` | Request count cap | Raise `daily_requests` |
| `model_class_not_permitted` | Wrong tier for user type | Fix app `modelClass` or policy |
| `feature_monthly_budget_exceeded` | Feature monthly cap | Raise feature budget |
| `global_monthly_budget_exceeded` | Project-wide stop | Ops: raise global cap |

Dry-run the same inputs without spend:

```bash
modelgov explain --local \
  --userType admin --feature event_flyer_extraction --modelClass standard
```

### Safety blocked (`status: safety_blocked`)

PII or prompt injection triggered. Review `safety` settings for the feature.
If legitimate content is blocked, adjust safety preset or preprocessing in the
app (never disable safety globally without review).

### Provider / infra (`status: failed`, HTTP 502/503)

- `provider_unavailable` — LiteLLM or upstream model down; check routing/fallback
- `safety_unavailable` — Presidio/safety backend down; strict presets fail closed

See [Failure semantics](../failure-semantics.md).

### App bug (Modelgov shows `ok`)

If `modelgov requests show` reports success but the product failed:

- App failed parsing model output
- App did not persist the draft after extraction
- Wrong feature or userType passed from session

Compare host `metadata.eventDraftId` with your database.

## Step 4 — Pattern-wide issues

When multiple users hit the same wall:

```bash
modelgov usage summary --since 24h
```

Look for:

- Spike in `blocked` count
- One feature dominating cost
- One `reasonCode` clustering

Runbooks:

- [Budget alerts](./budget-alerts.md)
- [Expensive queries](./expensive-queries.md)

## Step 5 — Resolve and document

| Resolution | Action |
| --- | --- |
| Budget too low | Update `modelgov.yaml`, deploy, `validate --production` |
| Wrong model class in app | Fix app code; add policy test case |
| Safety false positive | Tune feature safety or sanitize input |
| Provider outage | Wait or enable fallback model in `model_classes` |
| Missing correlation in app | Add logging per integration pattern |

After policy changes:

```bash
modelgov test-policy --file modelgov.policy-tests.yaml
```

## HTTP headers reference

| Header | When |
| --- | --- |
| `x-modelgov-request-id` | Success (`req_<n>`) and many error responses |
| `x-request-id` | HTTP trace id (UUID) on all API responses |

Success body: `requestId`. Error body: `details.auditRequestId` (audit) + `requestId` (HTTP trace).

## Related

- [Real app integration pattern](../integrations/real-app-pattern.md)
- [HTTP API](../api.md)
- [CLI operator commands](../operations.md)
