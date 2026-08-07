import type { GroundingCitationField } from "@modelgov/policy-engine";
import type { ChatMessage } from "../../types";

/**
 * Grounding enforcement (feature safety `grounding: strict`). The gateway owns
 * the grounded prompt — it is NOT left to the caller — so the "answer only from
 * context, cite your sources" contract can't be bypassed by the app. After the
 * model responds, we deterministically verify the cited quotes actually appear
 * in the supplied context; anything unverifiable is replaced with a safe
 * refusal. No extra model call is involved.
 *
 * The gateway owning the prompt is not the same as the gateway owning the
 * WORDING. A claims desk, a clinic and a support team want identical
 * enforcement and different copy, so persona/refusal/citation-fields come from
 * config. What is never configurable is whether verification runs.
 */

/**
 * Default persona. Unchanged from BEFORE grounding copy became configurable, so
 * upgrading from any released version alters nothing a deployment already ships
 * to its users. (Only a deployment tracking main between the commit that made
 * this configurable and this one saw the briefly-neutral wording.)
 *
 * It IS a customer-support voice, which is wrong for most deployments — that is
 * the whole reason `persona` exists. Any feature outside a support desk should
 * set it. Changing the default instead would silently reword live traffic on a
 * patch upgrade, which is not the gateway's call to make.
 */
export const DEFAULT_GROUNDING_PERSONA = "You are a customer-support assistant.";

/**
 * Default refusal, shown whenever the answer can't be verified against the
 * context. Also unchanged — note it promises a handoff to a human agent, which
 * a deployment with no support desk cannot honour. Set `refusal` for those.
 */
export const GROUNDING_REFUSAL =
  "I'm sorry — I couldn't find that in our knowledge base, so I don't want to guess. Let me connect you with a human support agent.";

/**
 * A retrieved passage. Callers may pass a bare string (the original shape); the
 * metadata fields exist so a feature can require citations to name the page or
 * section a quote came from, and so the gateway can VERIFY that claim rather
 * than pass it through.
 */
export interface GroundingPassage {
  text: string;
  page?: number | string;
  section?: string;
  title?: string;
  url?: string;
}

export interface GroundingOptions {
  persona?: string;
  refusal?: string;
  cite?: GroundingCitationField[];
}

/** Normalize the mixed string|object context into passages. */
export function toPassages(context: Array<string | GroundingPassage>): GroundingPassage[] {
  return context.map((c) => (typeof c === "string" ? { text: c } : c));
}

/** The passage fields a feature may require, in a stable order for prompts. */
const CITE_FIELDS: readonly GroundingCitationField[] = ["page", "section", "title", "url"];

export function citeFields(opts: GroundingOptions | undefined): GroundingCitationField[] {
  const requested = opts?.cite;
  if (!requested || requested.length === 0) return [];
  return CITE_FIELDS.filter((f) => requested.includes(f));
}

/** Render one passage's metadata for the prompt, e.g. `page=12 section="4.2"`. */
function metaLine(p: GroundingPassage, fields: GroundingCitationField[]): string {
  const parts = fields
    .map((f) => (p[f] === undefined ? null : `${f}=${JSON.stringify(p[f])}`))
    .filter((x): x is string => x !== null);
  return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

/**
 * Render each passage exactly as it appears in the grounded prompt.
 *
 * Injection screening MUST classify this, not the bare `text`. Metadata is
 * externally sourced like the passage body, and once `cite` is configured it is
 * rendered into the system prompt — so a passage could otherwise carry an
 * instruction in its `title` or `url` and reach the model unscreened. One
 * formatter, used by both, is what keeps the two from drifting apart again.
 */
export function renderPassages(
  passages: GroundingPassage[],
  fields: GroundingCitationField[],
): string[] {
  return passages.map((p, i) => `[${i + 1}]${metaLine(p, fields)} ${p.text}`);
}

function systemPrompt(
  context: string,
  persona: string,
  fields: GroundingCitationField[],
): string {
  // With citation fields configured the model must return objects, so the
  // required shape and the rules differ. Keeping the two prompts separate is
  // clearer than one prompt full of conditionals — and the no-fields branch is
  // byte-for-byte the prompt that shipped, so existing deployments see no drift.
  if (fields.length === 0) {
    return `${persona} Answer the user's question using ONLY the CONTEXT below. Do not use any outside knowledge, and never guess.

Respond with a SINGLE JSON object and nothing else, in exactly this shape:
{"found": true or false, "answer": "plain-language answer for the user", "quotes": ["an exact substring copied verbatim from the CONTEXT that supports the answer"]}

Rules:
- If the CONTEXT contains the answer: set "found" to true, write "answer", and include one or more "quotes" copied EXACTLY (character for character) from the CONTEXT.
- If the CONTEXT does NOT contain the answer: set "found" to false, set "quotes" to [], and put a brief apology in "answer".
- Never invent facts, prices, policies, names, or steps that are not in the CONTEXT.

CONTEXT:
${context}`;
  }

  const fieldList = fields.map((f) => `"${f}"`).join(", ");
  const example = fields.map((f) => `"${f}": <the ${f} of the passage you quoted>`).join(", ");
  return `${persona} Answer the user's question using ONLY the CONTEXT below. Do not use any outside knowledge, and never guess.

Respond with a SINGLE JSON object and nothing else, in exactly this shape:
{"found": true or false, "answer": "plain-language answer for the user", "citations": [{"quote": "an exact substring copied verbatim from the CONTEXT", ${example}}]}

Rules:
- If the CONTEXT contains the answer: set "found" to true, write "answer", and include one or more "citations". Each "quote" must be copied EXACTLY (character for character) from a single passage, and ${fieldList} must be that same passage's values, shown in parentheses after its number.
- If the CONTEXT does NOT contain the answer: set "found" to false, set "citations" to [], and put a brief apology in "answer".
- Never invent facts, prices, policies, names, or steps that are not in the CONTEXT.

CONTEXT:
${context}`;
}

/**
 * Prepend the gateway's grounding system prompt (built from the retrieved
 * passages) ahead of the caller's messages. Placed first so it dominates any
 * caller-supplied system message.
 */
export function buildGroundedMessages(
  messages: ChatMessage[],
  context: Array<string | GroundingPassage>,
  opts?: GroundingOptions,
): ChatMessage[] {
  const passages = toPassages(context);
  const fields = citeFields(opts);
  const joined = renderPassages(passages, fields).join("\n---\n");
  const persona = opts?.persona ?? DEFAULT_GROUNDING_PERSONA;
  return [{ role: "system", content: systemPrompt(joined, persona, fields) }, ...messages];
}

export interface GroundingVerdict {
  grounded: boolean;
  /** The verified answer, or the refusal when grounding fails. */
  answer: string;
  /** Cited quotes that were found verbatim in the context (for audit). */
  verifiedQuotes: number;
}

/** Collapse whitespace + lowercase so citation matching is robust to
 * re-wrapping and case, but still requires the words to actually be present. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// A quote must carry real signal — a one- or two-word "citation" would match
// almost any context and defeat verification.
const MIN_QUOTE_CHARS = 12;

/** Strip a leading "[N] " citation marker the model may have copied from the
 * numbered context it was shown (buildGroundedMessages adds those). */
function stripMarker(q: string): string {
  return q.replace(/^\s*\[\d+\]\s*/, "");
}

/** Compare a cited metadata value to a passage's. Loose across number/string
 * (a page is `12` in config and may come back as `"12"`) but nothing else. */
function metaMatches(cited: unknown, actual: number | string | undefined): boolean {
  if (actual === undefined) return false;
  if (typeof cited === "number" || typeof cited === "string") {
    return normalize(String(cited)) === normalize(String(actual));
  }
  return false;
}

interface Citation {
  quote: string;
  meta: Record<string, unknown>;
}

/**
 * Parse the model's structured answer and verify every citation. Fails closed
 * (refusal) on unparseable output, `found:false`, no citations, trivially short
 * quotes, any quote not present in a single passage, any cited metadata that
 * does not match the passage the quote was found in, or any numeric claim in
 * the answer that does not appear in the context.
 */
export function verifyGrounding(
  rawOutput: string,
  context: Array<string | GroundingPassage>,
  opts?: GroundingOptions,
): GroundingVerdict {
  const refusalText = opts?.refusal ?? GROUNDING_REFUSAL;
  const fields = citeFields(opts);
  const passages = toPassages(context);
  const refusal: GroundingVerdict = { grounded: false, answer: refusalText, verifiedQuotes: 0 };

  const parsed = extractJson(rawOutput);
  if (!parsed) return refusal;

  const found = parsed.found === true;
  const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
  const citations = readCitations(parsed);

  if (!found || !answer || citations.length === 0) return refusal;

  // Verify each quote against INDIVIDUAL passages, not a joined blob: joining
  // would let a "quote" that straddles two passages (present in neither) verify.
  // With citation fields configured the SAME passage must also carry the cited
  // metadata — checking the quote against one passage and the page against
  // another would let a real quote be attributed to the wrong page.
  const verified = citations.filter((c) => {
    const nq = normalize(stripMarker(c.quote));
    return passages.some(
      (p) => normalize(p.text).includes(nq) && fields.every((f) => metaMatches(c.meta[f], p[f])),
    );
  });
  // Every non-trivial citation must check out — one fabricated citation is
  // enough to distrust the whole answer.
  if (verified.length !== citations.length) {
    return { grounded: false, answer: refusalText, verifiedQuotes: verified.length };
  }

  // Quote presence proves a string was copyable from the context, NOT that the
  // answer follows from it — a model can cite a real phrase and still fabricate
  // specifics (prices, dates, durations). As a cheap, deterministic guard
  // consistent with the feature's fail-closed stance, require every numeric run
  // in the answer to also appear in the context. Word↔digit mismatches refuse
  // (safe: the refusal routes to a human).
  if (!numbersGrounded(answer, passages)) {
    return { grounded: false, answer: refusalText, verifiedQuotes: verified.length };
  }
  return { grounded: true, answer, verifiedQuotes: verified.length };
}

/**
 * Read citations from either shape — `quotes: ["..."]` or
 * `citations: [{quote, page, ...}]` — and drop trivially short ones.
 *
 * Both are accepted regardless of configuration, on purpose: a model handed the
 * citations prompt sometimes answers with bare `quotes` anyway, and rejecting
 * that outright would refuse an answer whose quote is perfectly verifiable. It
 * costs nothing to be lenient here because the metadata check below is what
 * enforces the contract — a bare quote carries no `page`, so under
 * `cite: [page]` it simply fails to verify.
 */
function readCitations(parsed: ParsedAnswer): Citation[] {
  const out: Citation[] = [];
  const push = (quote: unknown, meta: Record<string, unknown>) => {
    // Measure the anti-triviality gate on the marker-STRIPPED text (the same
    // form that is verified below), so a short quote can't slip past the length
    // gate by carrying a "[12] " prefix that is discarded before matching.
    if (typeof quote === "string" && normalize(stripMarker(quote)).length >= MIN_QUOTE_CHARS) {
      out.push({ quote, meta });
    }
  };
  if (Array.isArray(parsed.quotes)) {
    for (const q of parsed.quotes) push(q, {});
  }
  if (Array.isArray(parsed.citations)) {
    for (const c of parsed.citations) {
      if (c && typeof c === "object") {
        const obj = c as Record<string, unknown>;
        push(obj.quote, obj);
      }
    }
  }
  return out;
}

/** True when every digit-run in the answer also appears as a digit-run in the
 * context (or the answer has no numbers). Blocks fabricated numeric claims. */
function numbersGrounded(answer: string, passages: GroundingPassage[]): boolean {
  const answerNums = answer.match(/\d+/g);
  if (!answerNums) return true;
  // Metadata counts as context: with `cite: [page]` the model is shown page
  // numbers and may legitimately write "see page 12" in the answer.
  const haystack = passages
    .map((p) =>
      // `!== undefined`, not filter(Boolean): a page of 0 is a real page, and
      // dropping it would refuse an answer the context actually supports.
      // Matches the same enumeration in estimateInputTokensFromMessages.
      [p.text, p.page, p.section, p.title, p.url].filter((v) => v !== undefined).join(" "),
    )
    .join(" ");
  const contextNums = new Set(haystack.match(/\d+/g) ?? []);
  return answerNums.every((n) => contextNums.has(n));
}

interface ParsedAnswer {
  found?: unknown;
  answer?: unknown;
  quotes?: unknown;
  citations?: unknown;
}

/**
 * Extract the grounding answer object from the model output, tolerating
 * prose/code-fences both BEFORE and after it. Scans every `{` and returns the
 * first whose matching `}` span parses as JSON and looks like the answer shape.
 * Anchoring on the very first `{` (the old behavior) broke on leading prose that
 * contained a stray brace, e.g. "See item {A}: {\"found\":true,...}" — the walker
 * locked onto "{A}", failed to parse, and refused a valid answer.
 */
function extractJson(text: string): ParsedAnswer | null {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const end = matchingBrace(text, start);
    if (end === -1) break; // unbalanced from here on — no complete object remains
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as ParsedAnswer;
      // Skip stray objects in prose (e.g. "{A}" won't parse; a valid but
      // unrelated "{...}" is ignored unless it carries an answer-shaped key).
      if (
        obj &&
        typeof obj === "object" &&
        ("found" in obj || "answer" in obj || "quotes" in obj || "citations" in obj)
      ) {
        return obj;
      }
    } catch {
      // not valid JSON at this position — try the next "{"
    }
  }
  return null;
}

/** Index of the `}` matching the `{` at `start`, or -1 if unbalanced. Tracks
 * string/escape state so braces inside strings don't skew the depth count. */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
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
