import type { SafetyPlan } from "@modelgov/policy-engine";
import { SafetyServiceError, type SafetyFinding } from "../../services/safety";
import type { DocumentField } from "../../services/documents";
// TYPE-only import from service.ts: erased at compile time, so this does not
// create the runtime import cycle that would otherwise be TDZ-fragile (see the
// note in services/safety/contracts.ts). The value dependency runs one way,
// service.ts -> here.
import type { DocumentServiceDeps, StructuredOutput } from "./service";

// Masking the STRUCTURED half of a document result. Split from service.ts to
// keep that file under the 650-LOC limit; these two functions are self-contained
// and depend only on the structured payload shape.

/**
 * Every string leaf in the structured payload that could carry PII, as a flat
 * list plus the writers that put the masked values back. Collect-then-write
 * keeps the traversal in one place: masking is one `inspectOutputMany` call
 * (itself bounded-concurrent at the backend), and the shape is walked exactly
 * once instead of once per pass.
 */
export function structuredLeaves(s: StructuredOutput): {
  values: string[];
  write: (masked: string[]) => void;
} {
  const values: string[] = [];
  const writers: Array<(v: string) => void> = [];

  const addField = (f: DocumentField) => {
    if (typeof f.content === "string") {
      values.push(f.content);
      writers.push((v) => (f.content = v));
    }
    // Only string values: a number or boolean cannot hold a PII substring, and
    // coercing one to text would change the field's type in the response.
    if (typeof f.value === "string") {
      values.push(f.value);
      writers.push((v) => (f.value = v));
    }
  };

  for (const table of s.tables ?? []) {
    for (const cell of table.cells) {
      values.push(cell.content);
      writers.push((v) => (cell.content = v));
    }
  }
  for (const f of Object.values(s.fields ?? {})) addField(f);
  for (const doc of s.documents ?? []) for (const f of Object.values(doc.fields)) addField(f);

  return {
    values,
    write: (masked) => masked.forEach((v, i) => writers[i]?.(v)),
  };
}

/**
 * Mask the structured payload in place, so a caller gets its tables and fields
 * back instead of the empty object #37 had to substitute.
 *
 * Withholding was only ever a stand-in for this: the structured output holds
 * the same content as `text`, so under a blanket mask it would carry the PII
 * that was redacted from `text`. Masking the leaves removes that reason. A
 * per-entity policy is what makes the result USEFUL — an extraction feature can
 * allow the entity types it exists to extract and still redact the rest.
 *
 * Returns false when the payload had to be withheld anyway (no batch support on
 * the guard, or the backend refused), so the caller can keep reporting it.
 */
export async function maskStructured(
  deps: DocumentServiceDeps,
  structured: StructuredOutput,
  plan: SafetyPlan,
): Promise<{ masked: boolean; blocked: boolean; piiMasked: boolean; findings: SafetyFinding[] }> {
  const { values, write } = structuredLeaves(structured);
  if (values.length === 0) return { masked: true, blocked: false, piiMasked: false, findings: [] };
  // inspectOutputMany is optional on the interface; without it we cannot mask
  // the leaves in one pass, so fall back to the old withhold behaviour rather
  // than issue one round-trip per cell.
  if (!deps.safety.inspectOutputMany) {
    return { masked: false, blocked: false, piiMasked: false, findings: [] };
  }

  const res = await deps.safety.inspectOutputMany(values, plan);
  if (res.action === "block") {
    return { masked: false, blocked: true, piiMasked: false, findings: res.findings };
  }
  // Enforce the length invariant HERE, not just in CompositeGuard: SafetyGuard
  // is a public interface and another implementation returning a short array
  // would leave trailing fields unmasked while this reported success.
  if (res.contents.length !== values.length) {
    throw new SafetyServiceError(
      "safety guard returned a mismatched number of masked structured values",
    );
  }
  write(res.contents);
  // The guard already decided whether anything was redacted, and it is
  // plan-aware. Re-deriving it from findings here would be a second definition
  // of the same fact, free to drift from the first.
  return { masked: true, blocked: false, piiMasked: res.piiMasked, findings: res.findings };
}
