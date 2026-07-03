# Data flow & DLP

What data flows through Modelgov, what is **stored** versus **transient**, how PII
is handled, and where sensitive data could leak — with the controls that address
each. This is the reference for data-classification and privacy reviews.

Core stance: **prompt and completion content is transient by default.** Modelgov
persists **request metadata** (who, what feature, decision, cost) — not the text
of prompts or model responses — unless an operator explicitly enables a
content-capture option.

---

## End-to-end data flow

```text
 App                Modelgov API                 Backends
 ───                ────────────                 ────────
 request  ──HTTPS──► auth (API key / OIDC)
 { userId,          │
   userType,        ├─► load usage snapshot ──────────────► Postgres (read)
   feature,         │
   modelClass,      ├─► pure policy engine (no I/O)
   messages,        │
   metadata }       ├─► input safety ─── prompt text ─────► Presidio (analyze/anonymize)
                    │        (PII mask/block, injection)     [transient — not persisted by AG]
                    │
                    ├─► reserve budget ───────────────────► Postgres (write: budget_counters)
                    │
                    ├─► call model ── prompt text ─────────► LiteLLM ──► provider (OpenAI/…)
                    │        ◄── completion text ───────────
                    │
                    ├─► output safety ── completion ───────► Presidio
                    │
                    ├─► settle cost ──────────────────────► Postgres (write: budget_counters)
                    │
                    ├─► audit log (METADATA only) ─────────► Postgres (request_logs)
                    │
                    └─► optional trace ────────────────────► Langfuse
 response ◄─────────┘   (content only if OBSERVABILITY_CAPTURE_CONTENT=true)
 { message, decision,
   cost, budgetRemaining,
   safety, requestId }
```

Prompt/completion **content** exists in memory during a request and crosses the
network to Presidio, LiteLLM, and the upstream provider. Where it comes to **rest**
depends entirely on capture settings (below).

---

## Stored vs transient

| Data | Stored? | Where | Notes |
| --- | --- | --- | --- |
| `userId`, `userType`, `feature`, `modelClass` | **Stored** | `request_logs`, `budget_counters` | Identity/policy metadata for audit + accounting |
| Decision, `reasonCode`, cost (est/actual) | **Stored** | `request_logs` | Audit + cost attribution |
| Request `metadata` (≤32 keys) | **Stored** | `request_logs` | Operator search field; do **not** put secrets/PII here |
| **Prompt content** | **Transient** by default | in-memory only | Persisted only if a capture flag is on (see below) |
| **Completion content** | **Transient** by default | in-memory only | Persisted only if a capture flag is on |
| API-key secret | **Hash only** | `api_keys` | SHA-256 hash; plaintext returned once at create/rotate |
| Budget counters | **Stored** | `budget_counters` | Live spend/reservation state |
| Idempotency records | **Stored (short-lived)** | `idempotency_keys` | Swept when stale (`IDEMPOTENCY_STALE_MS`, default 15m) |
| Rate-limit counters | **Transient** | Redis (or in-memory) | Not durable business data |
| Provider API keys | **Not in Modelgov DB** | LiteLLM env / secrets mgr | Held by LiteLLM |

### Content-capture defaults (both OFF)

| Setting | Default | When ON |
| --- | --- | --- |
| `OBSERVABILITY_CAPTURE_CONTENT` | **`false`** | Prompt/completion content is sent to Langfuse traces (becomes a content-at-rest store you must protect) |
| `IDEMPOTENCY_CAPTURE_CONTENT` | **`false`** | Completion text is stored in `idempotency_keys` so replays return full content; with default off, replays return the envelope with **empty `message.content`** |

`GET /v1/requests` returns **metadata only** — prompts and completions are never
in `request_logs`. A future `requests:read_content` permission is **reserved** for
explicit content replay and is not enabled today.

---

## PII handling (DLP via Presidio)

PII controls are enforced by **Presidio** according to the safety preset (global
or per-`feature` in `modelgov.yaml`):

| `protect.pii` | Behavior |
| --- | --- |
| `mask` | Detected PII is anonymized/masked before the prompt reaches the provider (`safety.piiMasked: true` in the response) |
| `block` | A request containing detected PII is **blocked** → `403 safety_blocked` |
| `off` | No PII enforcement |

| Preset | PII / injection posture |
| --- | --- |
| `strict` | PII `block`, injection `block` |
| `balanced` | Moderate enforcement |
| `dev` | No-op guard — **Presidio not required, no PII enforcement** |

Prompt-injection detection (`protect.prompt_injection: block`) uses a classifier
(`injection_model`) and blocks flagged inputs.

**Fail-closed guarantee:** when safety is enabled and Presidio is unreachable, the
request is **rejected** (`503 safety_unavailable`), never sent unguarded — on both
input (before model) and output (after model; `retryable: false`, idempotency key
retained). If Presidio URLs are not configured while a preset expects PII
enforcement, the API logs a warning and PII rules are **not** enforced — so
production must set `PRESIDIO_ANALYZER_URL` / `PRESIDIO_ANONYMIZER_URL` and use a
non-`dev` preset.

> **Coverage caveat:** DLP effectiveness is bounded by Presidio's recognizer set.
> It is not a guarantee that all sensitive data is caught. Treat it as a strong
> control, not a perfect filter, and extend recognizers for domain-specific PII.

---

## Retention

| Data | Retention control | Default |
| --- | --- | --- |
| `request_logs` | Maintenance sweep to `REQUEST_LOG_RETENTION_MS` (single replica per tick via advisory lock) | **30 days** |
| `idempotency_keys` | Auto-swept when stale (`IDEMPOTENCY_STALE_MS`) | 15 min |
| Budget reservation leases | Released after `RESERVATION_STALE_MS` | 15 min |
| Langfuse content (if capture on) | **Governed by Langfuse**, not Modelgov | Operator sets |
| Idempotency content (if capture on) | Lives on `idempotency_keys` until swept | 15 min |

Set `REQUEST_LOG_RETENTION_MS` to match your data-retention policy. Content stores
(Langfuse) have independent retention you must configure.

---

## Data residency

Modelgov runs entirely on **your infrastructure** — Postgres, Redis, LiteLLM,
Presidio, and the API are all self-hosted, so their data resides wherever you
deploy them. The one boundary that leaves your environment is the **upstream model
provider**: prompt (post-masking) and completion content transit LiteLLM to
OpenAI/Anthropic/Gemini/Bedrock (or your chosen provider), whose processing region
and retention are governed by *your* contract with *that* provider. To keep data
in-region, choose a regional/self-hosted model (e.g. Bedrock in-region, Ollama via
`./setup` for the built-in demo provider or `make start-local` for Ollama) so no content leaves your boundary.

---

## Leak surfaces & controls

| Where data could leak | Control (shipped) | Residual / operator action |
| --- | --- | --- |
| Prompt content to the provider | Presidio mask/block **before** the model call; regional/self-hosted model option | Coverage = Presidio recognizers; `dev` preset disables it |
| Content persisted in traces | `OBSERVABILITY_CAPTURE_CONTENT=false` by default | If enabled, secure + set retention on Langfuse |
| Content persisted on replays | `IDEMPOTENCY_CAPTURE_CONTENT=false` by default | If enabled, `idempotency_keys` holds content until swept |
| Sensitive data in `metadata` | Documented as metadata (not policy-affecting); ≤32 keys | **Do not** place PII/secrets in `metadata` — it is stored in `request_logs` |
| API keys in the datastore | Stored as **SHA-256 hashes** only; plaintext returned once | Issuer must handle the one-time plaintext safely |
| `/metrics` exposure | Off public LB; `METRICS_AUTH_TOKEN` to require bearer | Metrics are aggregate (no content), but keep internal |
| Plaintext on the wire | TLS at LB (documented); `DATABASE_SSL=verify-full` for DB | **No built-in TLS** — operator must terminate it |
| Cross-tenant reads | Tenant-scoped keys read only their `projectId` partition; global counters hidden | Issue ops keys (all-tenant) narrowly |
| Provider keys | Held by LiteLLM, secrets manager, not git | Never commit `.env`; restrict LiteLLM exposure |
| Logs shipped off-host | Structured logs contain metadata + correlation IDs, not content | Confirm no content in your log pipeline before shipping to a SIEM |

Related: [threat model](./threat-model.md), [SOC 2 controls](./soc2-controls.md),
[operations — data retention & observability](../operations.md#data-retention),
[DPA / subprocessor outline](../commercial/security-questionnaire.md#dpa--subprocessor-outline).
