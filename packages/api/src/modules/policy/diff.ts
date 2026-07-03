import { parse as parseYaml } from "yaml";

export interface DiffEntry {
  /** Dotted path within the config, e.g. "budgets.global.monthly_usd". */
  path: string;
  /** Value in the "from" config (undefined = added in "to"). */
  from?: unknown;
  /** Value in the "to" config (undefined = removed from "from"). */
  to?: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Structural diff of two parsed objects. Arrays and scalars are compared as
 * leaves (by JSON equality); objects recurse. Returns one entry per changed
 * leaf/subtree, sorted by path — a readable "what changed" for policy review.
 */
export function deepDiff(from: unknown, to: unknown, base = ""): DiffEntry[] {
  if (isPlainObject(from) && isPlainObject(to)) {
    const out: DiffEntry[] = [];
    const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
    for (const k of keys) {
      out.push(...deepDiff(from[k], to[k], base ? `${base}.${k}` : k));
    }
    return out;
  }
  if (JSON.stringify(from) === JSON.stringify(to)) return [];
  return [{ path: base, from, to }];
}

/** Diff two modelgov.yaml documents (snake_case paths, matching the file). */
export function diffConfigYaml(fromYaml: string, toYaml: string): DiffEntry[] {
  const from = parseYaml(fromYaml) as unknown;
  const to = parseYaml(toYaml) as unknown;
  return deepDiff(from, to);
}
