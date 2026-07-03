# RAG support chatbot (grounded, embeddable)

A customer-service chatbot that answers **only** from a knowledge base — no
external sources, no hallucinations — and can be embedded on **any** website
with one `<script>` tag. It proves Modelgov end-to-end on a real use case:

- **Retrieval is governed** — the KB and every user question are embedded
  through Modelgov's `POST /v1/embeddings` (feature `kb_embedding`), so
  embedding spend is budgeted + audited like everything else. Vectors are stored
  in **Postgres/pgvector** (cosine kNN with an HNSW index).
- **Answers are grounded** — the `support_chat` feature is `grounding: strict`.
  The gateway owns the prompt, forces the model to cite verbatim quotes, and
  **verifies** those quotes are in the retrieved context. Anything it can't
  verify is replaced with a safe refusal (`safety.grounded: false`).
- **PII is masked** — `support_chat` has `protect.pii: mask`, so **Presidio**
  masks personal data in the visitor's question before it reaches the model.
- **Every reply carries a receipt** — model, decision, cost, and remaining
  daily budget, shown right in the widget.

Runs fully locally against **Ollama** (no cloud key): LiteLLM maps the cloud
model names in `modelgov.yaml` to `llama3.2:3b` (chat) and `nomic-embed-text`
(embeddings).

## Run it

**1. Pull the local models (once):**

```bash
ollama pull llama3.2:3b && ollama pull nomic-embed-text
```

**2. Start an Modelgov gateway that loads THIS folder's `modelgov.yaml`** and
maps models via `litellm.ollama.yaml`. From the repo root:

```bash
export MODELGOV_CONFIG=examples/rag_support/modelgov.yaml
export LITELLM_CONFIG=examples/rag_support/litellm.ollama.yaml
make up-local        # or: pnpm modelgov up local
```

> The gateway must have **Presidio** running (safety `pii: mask`) — the
> `simple`/`up-local` compose includes the analyzer + anonymizer services.

**3. Start a pgvector Postgres for the KB store:**

```bash
docker run -d --name rag-pgvector -p 5433:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ragkb pgvector/pgvector:pg16
```

**4. Ingest the knowledge base and start the widget server:**

```bash
cd examples/rag_support
cp .env.example .env
pnpm install
pnpm ingest          # embeds kb/*.md through the gateway → pgvector (kb_chunks)
pnpm serve           # http://localhost:3005
```

Open <http://localhost:3005> — a stand-in customer site with the widget in the
corner.

## Prove it — a 60-second tour

1. **Grounded question** → *"How long do refunds take?"* You get *"…within 5
   business days…"* with `grounded ✓`, the model, and the cost. The **sources**
   line shows `billing.md#Refunds`.
2. **Out-of-scope question** → *"Do you have an Android app?"* The KB has nothing
   on it, so the answer is a **refusal**, not a guess — the receipt shows
   `not grounded — refused`.
3. **Watch the budget** → each reply shows remaining daily budget. The `visitor`
   user type has a small `$0.50/day` cap; hammer it and you'll hit
   `budget_exceeded`, rendered as a friendly limit notice.
4. **Audit trail** → every embed + chat is a row in the gateway:
   `pnpm modelgov requests list`.

## Embed on your own site

```html
<script src="http://localhost:3005/widget.js"
        data-endpoint="http://localhost:3005/api/chat"
        data-title="Northwind Support"></script>
```

## How it fits together

```
question ─▶ /v1/embeddings (kb_embedding) ─▶ cosine top-k over pgvector
        └─▶ /v1/chat (support_chat, grounding: strict, context = top-k)
              └─▶ gateway verifies citations ─▶ grounded answer OR refusal
```

The vector store is **Postgres/pgvector** (`src/store.ts`): a `vector(N)` column
with an HNSW cosine index, queried with `embedding <=> $query`.

## Notes

- PII masking runs on the question, and grounding still works because the
  retrieved context is injected *after* masking (so the KB text is never
  redacted and citation verification stays exact).
- Grounded features can't stream (the answer must be verified before it's sent).
- Embedding dimension is detected at ingest (nomic-embed-text = 768,
  text-embedding-3-small = 1536) and the table is sized to match.
