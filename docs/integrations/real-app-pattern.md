# Real app integration pattern

This document shows how to embed Ai-Guard in a **real product flow** — not a
generic chat demo. The reference implementation is
[`examples/event_intake_app`](../../examples/event_intake_app): Jewgo-style event
flyer extraction.

## Boundary (read this first)

```text
Your app                          Ai-Guard
────────                          ────────
Who may use this feature?    →    Is this AI call allowed?
Business RBAC / auth              Budget, model class, safety
Creates domain objects            Never creates product records
```

Ai-Guard never replaces your authorization. It gates **AI execution** after your
app has already decided the user may attempt the action.

## End-to-end flow

```text
1. User action (upload flyer)
2. App auth check (admin can create drafts)
3. App selects feature + model class from product context
4. App calls Ai-Guard POST /v1/chat (or SDK ai.chat)
5. Ai-Guard evaluates policy → allow | block | degrade | fallback
6. On allow: LiteLLM runs; structured result returns to app
7. App persists domain object (event draft) + logs correlation ids
```

## Step-by-step

### 1. Auth check (your app)

Verify business permissions **before** calling Ai-Guard:

```ts
const session = requireAdmin(req.headers.authorization);
if (!session) return res.status(401).json({ error: "unauthorized" });
```

Ai-Guard API keys protect the gateway, not your end users. Pass `userId` and
`userType` from your session — Ai-Guard uses them for budget and model policy.

### 2. Feature selection

Every call must declare a `feature` defined in `ai-guard.yaml`:

```yaml
features:
  event_flyer_extraction:
    safety: balanced
    model_class: standard
    max_tokens: 1500
```

Map product actions to features explicitly. Do not reuse a generic `chat`
feature for unrelated workflows.

### 3. Model class selection

Pick the model tier in application code based on product rules:

```ts
modelClass: "standard"   // admin extraction
modelClass: "cheap"      // low-stakes preview
```

Ai-Guard enforces whether that class is permitted for the `userType` and whether
budget allows it.

### 4. Ai-Guard call

```ts
const result = await ai.chat({
  userId: session.userId,
  userType: "admin",
  feature: "event_flyer_extraction",
  modelClass: "standard",
  inputTokensEstimate: 1200,
  metadata: {
    app: "jewgo",
    eventDraftId: draftId,
    city: "miami",
  },
  messages: [
    { role: "system", content: "Extract JSON only." },
    { role: "user", content: flyerText },
  ],
});
```

**Metadata** is for logs and traces only. It does not affect policy unless you
add explicit rules later. Keep values small (≤32 keys).

### 5. Policy block handling

Catch typed SDK errors and return a product-appropriate response:

```ts
import { PolicyBlockedError } from "@ai-guard/sdk";

try {
  const result = await ai.chat({ ... });
} catch (err) {
  if (err instanceof PolicyBlockedError) {
    return res.status(402).json({
      error: "ai_policy_blocked",
      reasonCode: err.reasonCode,
      aiGuardRequestId: err.auditRequestId,
    });
  }
}
```

Stable `reasonCode` values (`daily_budget_exceeded`, `model_class_not_permitted`,
etc.) let your UI show actionable messages.

### 6. Correlation logging

Every successful chat response includes `requestId` (`req_<n>`):

```ts
console.log(
  `jewgo_event_draft=${draftId} ai_guard_request_id=${result.requestId}`,
);
```

On policy blocks, use `error.details.auditRequestId` (same format). The SDK
also exposes this as `err.auditRequestId`; the raw HTTP response usually also
has the `x-ai-guard-request-id` header.

Store both your domain id and Ai-Guard's id in your database for support.

### 7. Usage / debug flow

When something fails in production:

```bash
ai-guard requests show req_123
ai-guard usage summary --since 24h
```

See [Integration debugging runbook](../runbooks/integration-debugging.md).

## Dry-run before shipping

Use explain in CI or admin tools to preview decisions without spend:

```bash
ai-guard explain --local \
  --userType admin --feature event_flyer_extraction --modelClass standard
```

## Checklist

| Step | Owner | Done? |
| --- | --- | --- |
| Feature defined in `ai-guard.yaml` | Platform | |
| App auth before Ai-Guard call | App team | |
| `feature` + `userType` on every call | App team | |
| `PolicyBlockedError` handled | App team | |
| Correlation ids logged | App team | |
| `ai-guard test-policy` in CI | Platform | |
| `ai-guard validate --production` in deploy | Platform | |

## Examples

| Example | Pattern |
| --- | --- |
| [`event_intake_app`](../../examples/event_intake_app) | Non-chat workflow, admin auth, extraction |
| [`nextjs_support_chat`](../../examples/nextjs_support_chat) | Next.js API route, support chat |
| [`document_extraction`](../../examples/document_extraction) | Batch extraction with caps |

## Related

- [Mental model](../mental-model.md)
- [Integration checklist](../integration-checklist.md)
- [HTTP API — correlation ids](../api.md#request-correlation)
- [Failure semantics](../failure-semantics.md)
