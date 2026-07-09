# Document-AI governance — design & status

Governs OCR / document-extraction providers (Tesseract, Azure Document
Intelligence, and later Textract) as **first-class provider calls**, exactly like
an LLM request: the gateway calls the provider, meters real cost, enforces
budgets, masks PII in the result, and writes an audit row.

> **Status:** built (`POST /v1/documents/extract`). Providers **Tesseract**
> (self-hosted sidecar), **Azure DI** (REST), and **Amazon Textract** (SigV4, no
> AWS SDK). Reuses the embeddings reserve/settle/audit/billing spine verbatim —
> the only new surface is the provider client and a per-page cost basis.

## Why (and how it differs from external-cost recording)

Cost *attribution* added `POST /v1/usage/external`, which **records** non-LLM
cost after the fact (`decision='external'`, no enforcement). This is the
opposite: OCR/extraction is **governed** — budget-gated before the call, metered
after, PII-masked, and counted as a real request. The two coexist:

| | `POST /v1/usage/external` | `POST /v1/documents/extract` |
| --- | --- | --- |
| Who calls the provider | the caller (out of band) | the **gateway** |
| Budget enforcement | none (recording) | reserve → settle, blocks over cap |
| Audit `decision` | `external` (excluded from LLM summary) | `allow`/`degrade` (**counted**) |
| PII | n/a | masked on the extracted text |
| Use when | you can't/won't proxy it | you want it governed like an LLM |

## Architectural note (deliberate second egress)

Every other provider call goes through the LiteLLM proxy, which owns credentials.
Document-AI APIs are not LLM-chat, so LiteLLM can't front them: the gateway calls
them directly via a `DocumentAiClient` (`services/documents/`), with credentials
in the gateway env. This is the one place the "LiteLLM is the only egress"
invariant is knowingly broken; it is contained to `modules/documents/` +
`services/documents/`.

## Request lifecycle (mirrors `embeddings/service.ts`)

`handleDocumentExtract` (`modules/documents/service.ts`):
1. Resolve the provider adapter (enabled iff configured) and validate the
   document source kind is supported; SSRF-guard a `url` via `assertPublicHttpUrl`.
2. `evaluateAiRequest` (tokens = 0) → reuse budget **caps**, **safety plan**, and
   policy gating.
3. Cost basis is **pages**, not tokens: `estimatedCostUsd = estimatedPages ×
   perPageUsd` (`estimatedPages` = `max(body.pages, DOCUMENT_MAX_PAGES)`).
4. `acquireCreditHold` → `reserveBudget` (over cap → 403, hold released).
5. Provider call — `documentClient.get(provider).extract(source)`.
6. `settleActualCostWithRetry` with `actualPages × perPageUsd`.
7. **Output** PII masking — `safety.inspectOutput(text, plan)` (a scan's PII is
   discovered only after OCR; block → 403, mask → returned text).
8. `logRequest` (audit) — `resolved_model = provider`, `correlation_id =
   ctx.requestId`, so the call rolls up in `/v1/usage/transactions` with LLM calls.
9. `settleBillingCredits`; `providerBudget.release()` on any pre-settle failure.

## Providers & input model

- **tesseract** — self-hosted sidecar (`POST {TESSERACT_URL}/extract { base64 }
  → { text, pages }`); price 0 (still request/budget-governed). Inputs: `base64`,
  `url` (gateway fetches, SSRF-guarded).
- **azure-di** — Azure DI `prebuilt-read` REST: submit (`Ocp-Apim-Subscription-Key`)
  → poll `operation-location` to completion (bounded). Inputs: `base64`, `url`
  (incl. an Azure blob SAS URL, which DI pulls directly).
- **textract** — Amazon Textract `DetectDocumentText`, signed with a
  dependency-free SigV4 signer (`services/documents/sigv4.ts`) — no AWS SDK.
  Inputs: `base64`, `url` (gateway-fetched → `Bytes`), and `s3://bucket/key`
  (passed as `S3Object` for Textract to pull). Text = concatenated `LINE` blocks;
  pages = `DocumentMetadata.Pages`.
- Document source is exactly one of `{ base64 }`, `{ url }` (https), or `{ s3 }`
  (Textract only). Inline `base64` needs a raised `REQUEST_BODY_LIMIT_BYTES`,
  like the chat vision path.

## Config / env

| Env | Meaning |
| --- | --- |
| `TESSERACT_URL` | Tesseract sidecar URL (enables the provider) |
| `AZURE_DI_ENDPOINT` / `AZURE_DI_KEY` | Azure DI resource (enables the provider) |
| `AZURE_DI_API_VERSION` | override the DI API version |
| `TEXTRACT_REGION` | AWS region — the explicit enable signal for Textract |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` | Textract credentials |
| `DOCUMENT_PRICE_PER_PAGE_TESSERACT` / `_AZURE_DI` / `_TEXTRACT` | per-page USD cost basis |
| `DOCUMENT_MAX_PAGES` | worst-case pages reserved per request (budget-cap floor; default 30) |
| `TEXTRACT_S3_ALLOWED_BUCKETS` | buckets a caller may reference via an `s3` source (empty ⇒ `s3` rejected) |

Textract is enabled only when `TEXTRACT_REGION` **and** AWS credentials are set,
so generic AWS creds present for other reasons don't silently turn it on.

Permission: reuses **`chat:create`** (documents ride the data-plane key, like
embeddings). No new permission.

## Deferred / future

- **Textract multi-page** — the sync `DetectDocumentText` is single-page for
  images; multi-page async (`StartDocumentTextDetection` + S3 + polling) is a
  follow-up. The SigV4 signer is validated against live AWS only with real
  credentials (unit tests cover structure/determinism/sensitivity).
- Google Document AI, vision, transcription — same adapter-registry extension.
- Per-provider data-sensitivity approval (v1 inherits the nominal model_class's
  gating from `evaluateAiRequest`).

## Idempotency

`/v1/documents/extract` honors `Idempotency-Key` (like chat/embeddings): a
retried extract with the same key + body replays the stored result without
re-calling the provider or re-charging — a real safeguard given per-page spend. A
key reused with a different body is `422`; an in-flight key is `409`. With content
capture off, the stored replay omits the extracted text (`redactForStorage`).

## Verification

- `test/documents.integration.test.ts` — extract + per-page settle + governed
  audit row; output PII mask; budget block + release; provider-failure release;
  `provider_unavailable` / `unsupported_source`; **correlation rollup** (chat +
  document under one `x-request-id`) and **counted in `/v1/usage/summary`**.
- `test/documents-adapters.test.ts` — Tesseract + Azure DI against mocked `fetch`
  (submit + poll, SSRF guard, 4xx/5xx mapping).
