# TypeScript SDK

Package: `@modelgov/sdk` (monorepo: `packages/sdk-typescript`).

The SDK is a **thin HTTP client** to the Modelgov API. Policy enforcement is
always server-side.

## Install

From the Modelgov monorepo (workspace):

```json
{ "dependencies": { "@modelgov/sdk": "workspace:*" } }
```

When published to npm (future): `npm install @modelgov/sdk`.

## Create a client

```typescript
import { createModelgovClient } from "@modelgov/sdk";

const ai = createModelgovClient({
  baseUrl: process.env.MODELGOV_URL ?? "http://localhost:3090",
  apiKey: process.env.MODELGOV_API_KEY,
  timeoutMs: 60_000, // default; set null to disable
});
```

## Chat request

```typescript
const res = await ai.chat({
  userId: string,           // your end-user id
  userType: UserTypeName,   // must match modelgov.yaml budgets
  feature: FeatureName,     // required — registered feature
  messages: ChatMessage[],
  modelClass?: ModelClassName,
  inputTokensEstimate?: number,
  temperature?: number,
  projectId?: string,
  environment?: string,
  metadata?: Record<string, unknown>,
});
```

### Generated types

`FeatureName`, `UserTypeName`, and `ModelClassName` are generated from
`modelgov.yaml`:

```bash
pnpm generate-sdk-types
```

Invalid feature names fail at **compile time** in TypeScript.

## Response

```typescript
interface ChatResponse {
  message: { role: string; content: string };
  model: string;
  decision: "allow" | "degrade" | "fallback";
  reason?: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  cost: { estimatedUsd: number; actualUsd: number };
  budgetRemaining: {
    userDailyUsd: number;
    featureMonthlyUsd: number | null;
    globalMonthlyUsd: number;
  };
  safety: { piiMasked: boolean; injectionBlocked: boolean };
  /** Audit log id — log alongside your domain entity id. */
  requestId: string;
}
```

Log `requestId` with your product ids (`eventDraftId`, ticket id, etc.) for
support. On policy blocks, use `err.auditRequestId` from `PolicyBlockedError`,
or read `err.body.error.details.auditRequestId` directly from the response body.

## Streaming

`chatStream()` streams a completion as it is generated. It yields text deltas and
returns a final metadata frame once the stream finishes. Pre-stream failures
(policy / safety / budget / provider) throw the same typed errors as `chat()`, so
wrap the loop in `try/catch`. Streaming requires the feature's **output PII
protection to be off** — the server rejects the request otherwise.

```typescript
try {
  const stream = ai.chatStream({
    userId,
    userType,
    feature: "support_chat",
    messages: [{ role: "user", content: message }],
  });

  let done: Awaited<ReturnType<typeof stream.next>>["value"];
  for (;;) {
    const chunk = await stream.next();
    if (chunk.done) {
      done = chunk.value; // { done, model, usage, requestId } | undefined
      break;
    }
    process.stdout.write(chunk.value); // text delta
  }

  if (done) console.log(`\n[${done.model}] requestId=${done.requestId}`);
} catch (err) {
  if (err instanceof PolicyBlockedError) {
    /* over budget / token limit */
  }
}
```

The done frame is a `ChatStreamDone`:

```typescript
interface ChatStreamDone {
  done: true;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  requestId: string;
}
```

`chatStream()` accepts the same `RequestOptions` (`timeoutMs`, `signal`) as
`explain()`.

## Errors

| Class | When |
| --- | --- |
| `PolicyBlockedError` | 403 `policy_blocked` or `budget_exceeded` |
| `SafetyBlockedError` | 403 `safety_blocked` |
| `ModelgovError` | Other 4xx/5xx |

```typescript
import { PolicyBlockedError, SafetyBlockedError } from "@modelgov/sdk";

try {
  await ai.chat({ ... });
} catch (err) {
  if (err instanceof PolicyBlockedError) {
    console.error(err.body); // structured API error
  }
}
```

## Idempotency

Pass a stable key to safely retry without double-charging:

```typescript
await ai.chat(request, { idempotencyKey: `chat-${userId}-${sessionId}` });
```

The API returns `x-idempotent-replay: true` on cache hits.

## Timeouts and cancellation

Requests time out after 60 seconds by default. Override globally on the client or
per call, and pass an `AbortSignal` when your framework already owns request
cancellation:

```typescript
await ai.chat(request, {
  timeoutMs: 15_000,
  signal: requestAbortSignal,
});
```

## Integration pattern

```text
1. Authenticate user (your app)
2. Authorize product action (your app)
3. ai.chat({ userId, userType, feature, messages })
4. Return res.message.content to user
```

Never call Modelgov before your app has decided the user may use this feature.

## Example

Full demo: [`examples/support_chat`](../examples/support_chat/README.md).
