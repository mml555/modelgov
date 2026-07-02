# Document extraction example

Shows a **non-chat AI workflow**: structured extraction with a daily cap,
standard model class, fallback routing, and hard budget stops.

## Policy highlights

- Feature `document_extraction` — `standard` model, strict safety
- Per-user cap: **5 extractions/day** on the `workflow` user type
- Feature monthly budget: **$25**
- Global hard stop at 100% of monthly spend
- Primary `anthropic/claude-sonnet` with `openai/gpt-4o` fallback

## Try offline

```bash
pnpm build
pnpm ai-guard explain --local \
  --config examples/document_extraction/ai-guard.yaml \
  --userType workflow --feature document_extraction --modelClass standard
```

## Run live

```bash
export AI_GUARD_CONFIG=examples/document_extraction/ai-guard.yaml
make setup

AI_GUARD_API_KEY=sk-ai-guard-api-local \
  pnpm --filter document-extraction-example start
```

Pass a document snippet:

```bash
AI_GUARD_API_KEY=sk-ai-guard-api-local \
  pnpm --filter document-extraction-example start "Invoice #1042 from Acme Corp, total $1,250 due April 1"
```

## What this proves

Ai-Guard is not only for chatbots. Any AI call that declares a `feature` gets
the same budgets, safety, routing, and audit trail.
