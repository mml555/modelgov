import type { ChatMessage } from "../../types";

/**
 * Grounding enforcement (feature safety `grounding: strict`). The gateway owns
 * the grounded prompt — it is NOT left to the caller — so the "answer only from
 * context, cite your sources" contract can't be bypassed by the app. After the
 * model responds, we deterministically verify the cited quotes actually appear
 * in the supplied context; anything unverifiable is replaced with a safe
 * refusal. No extra model call is involved.
 */

/** Shown to the user whenever the answer can't be verified against the context. */
export const GROUNDING_REFUSAL =
  "I'm sorry — I couldn't find that in our knowledge base, so I don't want to guess. Let me connect you with a human support agent.";

function systemPrompt(context: string): string {
  return `You are a customer-support assistant. Answer the user's question using ONLY the CONTEXT below. Do not use any outside knowledge, and never guess.

Respond with a SINGLE JSON object and nothing else, in exactly this shape:
{"found": true or false, "answer": "plain-language answer for the user", "quotes": ["an exact substring copied verbatim from the CONTEXT that supports the answer"]}

Rules:
- If the CONTEXT contains the answer: set "found" to true, write "answer", and include one or more "quotes" copied EXACTLY (character for character) from the CONTEXT.
- If the CONTEXT does NOT contain the answer: set "found" to false, set "quotes" to [], and put a brief apology in "answer".
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
  context: string[],
): ChatMessage[] {
  const joined = context.map((c, i) => `[${i + 1}] ${c}`).join("\n---\n");
  return [{ role: "system", content: systemPrompt(joined) }, ...messages];
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

/**
 * Parse the model's structured answer and verify every cited quote appears in
 * the context. Fails closed (refusal) on unparseable output, `found:false`, no
 * quotes, trivially short quotes, any quote not present in the context, or any
 * numeric claim in the answer that does not appear in the context.
 */
export function verifyGrounding(rawOutput: string, context: string[]): GroundingVerdict {
  const refusal: GroundingVerdict = { grounded: false, answer: GROUNDING_REFUSAL, verifiedQuotes: 0 };

  const parsed = extractJson(rawOutput);
  if (!parsed) return refusal;

  const found = parsed.found === true;
  const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
  // Measure the anti-triviality gate on the marker-STRIPPED text (the same form
  // that is verified below), so a short quote can't slip past the length gate by
  // carrying a "[12] " prefix that is discarded before matching.
  const quotes = Array.isArray(parsed.quotes)
    ? parsed.quotes.filter(
        (q): q is string =>
          typeof q === "string" && normalize(stripMarker(q)).length >= MIN_QUOTE_CHARS,
      )
    : [];

  if (!found || !answer || quotes.length === 0) return refusal;

  // Verify each quote against INDIVIDUAL passages, not a joined blob: joining
  // would let a "quote" that straddles two passages (present in neither) verify.
  const passages = context.map(normalize);
  const verified = quotes.filter((q) => {
    const nq = normalize(stripMarker(q));
    return passages.some((p) => p.includes(nq));
  });
  // Every non-trivial cited quote must be present — one fabricated citation is
  // enough to distrust the whole answer.
  if (verified.length !== quotes.length) {
    return { grounded: false, answer: GROUNDING_REFUSAL, verifiedQuotes: verified.length };
  }

  // Quote presence proves a string was copyable from the context, NOT that the
  // answer follows from it — a model can cite a real phrase and still fabricate
  // specifics (prices, dates, durations). As a cheap, deterministic guard
  // consistent with the feature's fail-closed stance, require every numeric run
  // in the answer to also appear in the context. Word↔digit mismatches refuse
  // (safe: the refusal routes to a human).
  if (!numbersGrounded(answer, context)) {
    return { grounded: false, answer: GROUNDING_REFUSAL, verifiedQuotes: verified.length };
  }
  return { grounded: true, answer, verifiedQuotes: verified.length };
}

/** True when every digit-run in the answer also appears as a digit-run in the
 * context (or the answer has no numbers). Blocks fabricated numeric claims. */
function numbersGrounded(answer: string, context: string[]): boolean {
  const answerNums = answer.match(/\d+/g);
  if (!answerNums) return true;
  const contextNums = new Set(context.join(" ").match(/\d+/g) ?? []);
  return answerNums.every((n) => contextNums.has(n));
}

interface ParsedAnswer {
  found?: unknown;
  answer?: unknown;
  quotes?: unknown;
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
        ("found" in obj || "answer" in obj || "quotes" in obj)
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
