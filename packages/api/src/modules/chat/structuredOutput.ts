import type { SafetyPlan } from "@modelgov/policy-engine";
import { SafetyServiceError, type OutputSafetyResult, type SafetyGuard } from "../../services/safety";

/**
 * Output PII masking for a STRUCTURED chat response.
 *
 * `inspectOutput` treats the completion as prose and rewrites detected spans in
 * the serialized text. For a `responseFormat` response that text is JSON, so a
 * span that straddles a delimiter can damage the structure rather than a value
 * — and even when it does not, the caller is left unable to tell "the model did
 * not extract this" from "policy rewrote it".
 *
 * So parse first and mask the string LEAVES, which keeps the document
 * well-formed by construction. `/documents` already does the equivalent via
 * structuredMasking.ts; this is the /chat side of that parity.
 *
 * NOTE for `json_schema` callers: a masked value is `[REDACTED]`, which will
 * violate a schema that declared the field as a date, enum, or number. That is
 * reported rather than hidden — see `structuredMasked` on the response — and the
 * real fix for an extraction feature is a per-entity `pii` policy that allows
 * the entity types it exists to extract.
 */
export interface StructuredMaskResult {
  content: string;
  /** True when a string leaf was actually rewritten. */
  masked: boolean;
  action: "allow" | "block";
  blockReason?: OutputSafetyResult["blockReason"];
  findings: OutputSafetyResult["findings"];
  /** False when the payload could not be parsed as JSON — caller falls back. */
  structured: boolean;
}

/** Every string leaf, plus the writers that put masked values back. */
function stringLeaves(root: unknown): {
  values: string[];
  write: (masked: string[]) => void;
} {
  const values: string[] = [];
  const writers: Array<(v: string) => void> = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => {
        if (typeof child === "string") {
          values.push(child);
          writers.push((v) => {
            node[i] = v;
          });
        } else walk(child);
      });
      return;
    }
    if (node !== null && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      // Keys are NOT masked: they are the caller's schema, not model-supplied
      // content, and rewriting them would break the contract the schema states.
      for (const key of Object.keys(obj)) {
        const child = obj[key];
        if (typeof child === "string") {
          values.push(child);
          writers.push((v) => {
            obj[key] = v;
          });
        } else walk(child);
      }
    }
  };

  walk(root);
  return { values, write: (masked) => masked.forEach((v, i) => writers[i]?.(v)) };
}

/**
 * Mask a structured completion value-by-value.
 *
 * Returns `structured: false` ONLY when `content` is not a JSON object/array
 * (a model can ignore `responseFormat`), so the caller falls back to ordinary
 * prose masking rather than skipping output safety altogether. A structured
 * payload the guard cannot mask fails closed instead.
 */
export async function maskStructuredOutput(
  safety: SafetyGuard,
  content: string,
  plan: SafetyPlan,
): Promise<StructuredMaskResult> {
  const none = { content, masked: false, action: "allow" as const, findings: [], structured: false };

  // Nothing would be masked anyway — let the ordinary path no-op. Without this
  // the fail-closed branch below 503s a `pii: off` feature that merely asked
  // for structured output, on any guard lacking the optional batch method.
  if (plan.pii === "off" || plan.piiScope === "input") return none;

  // Parse BEFORE checking for batch support. Bailing out early sent a valid
  // JSON payload down the prose path, where a mask spanning a delimiter can
  // invalidate the document — the exact corruption this module exists to
  // prevent. Only genuinely non-structured content may fall back.
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return none;
  }
  // A bare JSON scalar has no leaves to walk and is indistinguishable from
  // prose for masking purposes; let the normal path handle it.
  if (parsed === null || typeof parsed !== "object") return none;

  // Structured payload, but the guard cannot mask leaves. Fail closed rather
  // than prose-mask valid JSON: the built-in CompositeGuard implements this, so
  // only a custom guard reaches here, and returning a possibly-corrupted
  // payload is worse than a 503. Matches how the guard already treats "PII
  // protection enabled but no backend configured".
  if (!safety.inspectOutputMany) {
    throw new SafetyServiceError(
      "output PII masking is enabled for a structured response, but the safety guard cannot mask structured values",
    );
  }

  const { values, write } = stringLeaves(parsed);
  if (values.length === 0) {
    return { content, masked: false, action: "allow", findings: [], structured: true };
  }

  const res = await safety.inspectOutputMany(values, plan);
  if (res.action === "block") {
    return {
      content,
      masked: false,
      action: "block",
      blockReason: res.blockReason,
      findings: res.findings,
      structured: true,
    };
  }
  if (res.contents.length !== values.length) {
    // Never pair a masked value with the wrong field, and never fall back to
    // the original, which still holds the PII we were asked to redact.
    //
    // SafetyServiceError, not a plain Error: the pipeline's catch settles
    // billing for that type only, and the provider call has already happened.
    // A plain Error escaped that handler and left the hold unsettled.
    throw new SafetyServiceError("safety guard returned a mismatched number of masked values");
  }
  write(res.contents);
  return {
    content: JSON.stringify(parsed),
    masked: res.piiMasked,
    action: "allow",
    findings: res.findings,
    structured: true,
  };
}
