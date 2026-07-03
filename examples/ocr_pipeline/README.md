# Hybrid OCR pipeline (PDF/image → structured data)

Turn PDFs and images into structured JSON — governed by Modelgov end to end.
It's **hybrid**: local **Tesseract** OCR text *and* the page image are sent
together to a **vision model**, so the model gets both the exact characters and
the layout. Every extraction call runs through the gateway:

- **Governed vision** — the `document_extraction` feature routes to the `vision`
  model class (data-sensitivity–gated to approved models); each call is
  budgeted and audited.
- **Multimodal** — uses Modelgov's content-parts support: `[ text (instruction +
  OCR), image ]` in one message.
- **PII protection (optional)** — set the feature's safety to `balanced` (with
  Presidio) and the gateway masks names, emails, and card numbers in the
  extracted output.

Runs locally against **Ollama** (no cloud key): LiteLLM maps the vision model
name to `llama3.2-vision` (or `llava`).

## Prerequisites

```bash
brew install tesseract poppler imagemagick   # OCR, PDF→image, sample generator
```

Plus a vision model — pick one:

- **Cloud (no download):** set `GEMINI_API_KEY` and use `litellm.gemini.yaml`
  (routes the vision class to `gemini-flash-lite-latest`). This is the path this
  pipeline was verified against.
- **Local (offline):** `ollama pull llama3.2-vision` (or `ollama pull llava`) and
  use `litellm.ollama.yaml`.

## Run it

**1. Start an Modelgov gateway that loads THIS folder's `modelgov.yaml`** and
maps the vision model via `litellm.ollama.yaml`. From the repo root:

```bash
export MODELGOV_CONFIG=examples/ocr_pipeline/modelgov.yaml
# Cloud (verified):   export LITELLM_CONFIG=examples/ocr_pipeline/litellm.gemini.yaml
# Local (offline):    export LITELLM_CONFIG=examples/ocr_pipeline/litellm.ollama.yaml
export LITELLM_CONFIG=examples/ocr_pipeline/litellm.gemini.yaml
make up-local
```

**2. Generate a sample receipt and extract it:**

```bash
cd examples/ocr_pipeline
cp .env.example .env
pnpm install
pnpm sample                          # writes sample-receipt.png (via ImageMagick)
pnpm extract sample-receipt.png      # → structured JSON + receipt
```

Or point it at your own file:

```bash
pnpm extract /path/to/invoice.pdf
pnpm extract /path/to/scan.jpg
```

## What you'll see

```
── page 1 ──────────────────────────────
{
  "vendor": "NORTHWIND CAFE",
  "document_type": "receipt",
  "date": "2026-06-30",
  "currency": "USD",
  "total": 14.85,
  "line_items": [ { "description": "Cappuccino", "quantity": 2, "amount": 8.0 }, ... ]
}

  ocr: 312 chars · openai/gpt-4o (ollama, allow) · $0.00000 · req req_42
```

Every page is one audited row: `pnpm modelgov requests list`.

## How it fits together

```
file ─▶ renderPages()            PDF → pages via pdftoppm; image → as-is
     ─▶ per page:
          Tesseract OCR text  ┐
          page image (base64) ┴─▶ /v1/chat (document_extraction, vision, content-parts)
                                    └─▶ structured JSON  (+ PII masked if safety=balanced)
```

## Notes

- **PII masking** is on: `document_extraction.safety.protect` sets
  `pii: mask` + `pii_scope: output`, so **Presidio** masks personal data
  (emails, names, addresses, card numbers) in the extracted JSON — the model
  still reads the full document, but the returned data is redacted. Requires
  Presidio running (the `simple`/`up-local` compose includes it).
- Presidio's default recognizers are aggressive (they also flag dates and some
  nouns). For production, tune the entity list / score threshold so only true
  PII is masked.
- Reasoning models (e.g. `gemini-2.5-flash`) spend tokens "thinking", so
  `max_tokens` is set to 2048 to avoid truncating the JSON.
- Local vision models are slow; the client timeout is raised to 180s and pages
  run one at a time.
- Accuracy scales with the model — `llama3.2-vision`/`llava` are fine for the
  demo; point the config at `openai/gpt-4o` (real key) for production-grade
  extraction with no code change.
