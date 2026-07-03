import type { ModelgovConfig } from "./types";

// Model-class tiers are ordered cheapest → most expensive. "Degrade" means
// stepping DOWN to a cheaper tier. This built-in order is the default; a config
// can override it with `routing.class_order`. Classes not in the effective
// order are treated as un-degradable.
export const CLASS_TIERS = ["cheap", "standard", "premium"] as const;

/** Provider slug from a LiteLLM model string, e.g. "openai/gpt-4o-mini" -> "openai". */
export function providerOf(model: string): string {
  const slash = model.indexOf("/");
  return slash === -1 ? "unknown" : model.slice(0, slash);
}

export interface ResolvedModelInfo {
  model: string;
  provider: string;
  fallback?: string;
}

/**
 * Resolve the concrete model for a class. `useFallback` selects the class's
 * fallback model (falling back to primary if no fallback is configured).
 */
export function resolveModelInfo(
  config: ModelgovConfig,
  className: string,
  useFallback: boolean,
): ResolvedModelInfo {
  const cc = config.modelClasses[className];
  if (!cc) {
    // Caller validates existence first; this guards the type narrowing.
    throw new Error(`model_class '${className}' is not defined`);
  }
  const model = useFallback ? cc.fallback ?? cc.primary : cc.primary;
  return { model, provider: providerOf(model), fallback: cc.fallback };
}

/**
 * Find the next cheaper class that is BOTH defined in config.modelClasses AND
 * permitted for the user type. Returns null when no cheaper permitted class
 * exists (so degradation simply can't apply).
 */
export function nextPermittedCheaperClass(
  current: string,
  permitted: readonly string[],
  config: ModelgovConfig,
): string | null {
  // Configurable order (cheapest → most expensive), else the built-in tiers.
  const order: readonly string[] = config.routing.classOrder ?? CLASS_TIERS;
  const idx = order.indexOf(current);
  if (idx <= 0) return null; // already cheapest, or not in the ordering
  for (let i = idx - 1; i >= 0; i--) {
    const candidate = order[i]!;
    if (permitted.includes(candidate) && config.modelClasses[candidate]) {
      return candidate;
    }
  }
  return null;
}
