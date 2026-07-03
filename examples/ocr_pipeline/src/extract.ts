import type { ModelgovClient } from "@modelgov/sdk";
import { EXTRACT_FEATURE, WORKFLOW } from "./modelgov.js";
import { imageDataUrl, ocrText, renderPages } from "./render.js";

const INSTRUCTION = `You are a document data-extraction engine. Using BOTH the OCR text and the document image, extract the key fields as a single JSON object and return ONLY that JSON (no prose, no code fences).

Include these keys when present, using null when a value is missing:
  vendor, document_type, date, currency, subtotal, tax, total,
  line_items (array of {description, quantity, unit_price, amount})
Also include any other clearly-labeled fields you see. Do NOT invent values that are not in the document.`;

export interface ExtractionReceipt {
  model: string;
  provider: string;
  decision: string;
  costUsd: number;
  requestId: string;
}

export interface PageExtraction {
  page: number;
  fields: Record<string, unknown> | null;
  /** Raw model output (useful when JSON parsing fails). */
  rawOutput: string;
  ocrChars: number;
  receipt: ExtractionReceipt;
}

/**
 * Extract the JSON object from model output, tolerating prose / code-fences both
 * BEFORE and after it. Scans every `{` and returns the first whose matching `}`
 * span parses as a JSON object. Anchoring on the very first `{` (the old
 * behavior) broke on leading prose containing a stray brace, e.g.
 * "Result for order {A}: {...}" — it locked onto "{A}", failed to parse, and
 * dropped a valid extraction.
 */
export function parseExtraction(raw: string): Record<string, unknown> | null {
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    const end = matchingBrace(raw, start);
    if (end === -1) break; // unbalanced from here on — no complete object remains
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not valid JSON at this position — try the next "{"
    }
  }
  return null;
}

/** Index of the `}` matching the `{` at `start`, or -1 if unbalanced. Tracks
 * string/escape state so braces inside strings don't skew the depth count. */
function matchingBrace(raw: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Rough token estimate so the budget reservation reflects the real payload. */
function estimateTokens(ocr: string): number {
  return Math.ceil(ocr.length / 4) + 1200; // + ~image tokens
}

/**
 * Extract structured data from one page: Tesseract OCR text + the page image are
 * sent together to the gateway's vision `document_extraction` feature. The call
 * is budgeted + audited; PII in the output is masked if the feature enables it.
 */
export async function extractPage(
  ai: ModelgovClient,
  imagePath: string,
  page: number,
): Promise<PageExtraction> {
  const [ocr, dataUrl] = await Promise.all([ocrText(imagePath), imageDataUrl(imagePath)]);

  const res = await ai.chat({
    userId: "ocr-worker",
    userType: WORKFLOW,
    feature: EXTRACT_FEATURE,
    inputTokensEstimate: estimateTokens(ocr),
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `${INSTRUCTION}\n\nOCR TEXT:\n${ocr || "(none)"}` },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  return {
    page,
    fields: parseExtraction(res.message.content),
    rawOutput: res.message.content,
    ocrChars: ocr.length,
    receipt: {
      model: res.model,
      provider: res.provider,
      decision: res.decision,
      costUsd: res.cost.actualUsd,
      requestId: res.requestId,
    },
  };
}

/** Render a PDF/image to pages and extract each page. */
export async function extractDocument(ai: ModelgovClient, inputPath: string): Promise<PageExtraction[]> {
  const { pages, cleanup } = await renderPages(inputPath);
  const out: PageExtraction[] = [];
  try {
    // Sequential: local vision models are heavy; one page at a time keeps memory
    // and the provider load sane (and preserves page order in the output).
    for (let i = 0; i < pages.length; i++) {
      out.push(await extractPage(ai, pages[i] as string, i + 1));
    }
    return out;
  } finally {
    // Always remove rasterized PDF pages from the temp dir, even on failure.
    await cleanup();
  }
}
