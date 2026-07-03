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
pnpm modelgov explain --local \
  --config examples/document_extraction/modelgov.yaml \
  --userType workflow --feature document_extraction --modelClass standard
```

## Run live

```bash
export MODELGOV_CONFIG=examples/document_extraction/modelgov.yaml
make setup

MODELGOV_API_KEY=sk-modelgov-api-local \
  pnpm --filter document-extraction-example start
```

Pass a document snippet:

```bash
MODELGOV_API_KEY=sk-modelgov-api-local \
  pnpm --filter document-extraction-example start "Invoice #1042 from Acme Corp, total $1,250 due April 1"
```

## What this proves

Modelgov is not only for chatbots. Any AI call that declares a `feature` gets
the same budgets, safety, routing, and audit trail.
