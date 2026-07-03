// Static price table for cost *estimation* only. The reservation uses this
// estimate; the real cost returned by LiteLLM reconciles it after the call
// (recordActualCost). Prices are USD per 1K tokens. Keep keys aligned with the
// model strings used in `modelgov.yaml` model_classes.

import type { ModelgovConfig } from "./types";

export interface ModelPrice {
  inputPer1k: number;
  outputPer1k: number;
}

export const PRICE_TABLE: Record<string, ModelPrice> = {
  "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "openai/gpt-4.1-mini": { inputPer1k: 0.0004, outputPer1k: 0.0016 },
  "openai/gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01 },
  "openai/gpt-5": { inputPer1k: 0.00125, outputPer1k: 0.01 },
  "anthropic/claude-sonnet": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "anthropic/claude-opus": { inputPer1k: 0.015, outputPer1k: 0.075 },
  "anthropic/claude-haiku": { inputPer1k: 0.0008, outputPer1k: 0.004 },
  "gemini/gemini-flash": { inputPer1k: 0.000075, outputPer1k: 0.0003 },
  "gemini/gemini-pro": { inputPer1k: 0.00125, outputPer1k: 0.005 },
};

/** Conservative fallback when a model is not in the table. */
export const DEFAULT_PRICE: ModelPrice = { inputPer1k: 0.001, outputPer1k: 0.004 };

/** Assumed input size when the caller provides no token estimate. */
export const DEFAULT_INPUT_TOKENS = 500;

/**
 * Resolve a model's price: config `pricing` override → built-in table →
 * conservative default. `overrides` come from `modelgov.yaml`'s `pricing:`.
 */
export function getModelPrice(
  model: string,
  overrides?: Record<string, ModelPrice>,
): ModelPrice {
  return overrides?.[model] ?? PRICE_TABLE[model] ?? DEFAULT_PRICE;
}

/** Round to 6 decimal places to match Postgres numeric(12,6). */
export function roundUsd(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Worst-case cost estimate: assumes the model emits the full maxOutputTokens.
 * Deliberately conservative so the reservation never under-books in-flight cost.
 */
export function estimateCostUsd(
  model: string,
  inputTokensEstimate: number | undefined,
  maxOutputTokens: number,
  overrides?: Record<string, ModelPrice>,
): number {
  const price = getModelPrice(model, overrides);
  const inputTokens = inputTokensEstimate ?? DEFAULT_INPUT_TOKENS;
  const cost =
    (inputTokens / 1000) * price.inputPer1k +
    (maxOutputTokens / 1000) * price.outputPer1k;
  return roundUsd(cost);
}

/**
 * Worst-case token estimate: assumed/declared input tokens plus the full
 * maxOutputTokens. Mirrors estimateCostUsd so token reservations never
 * under-book in-flight usage.
 */
export function estimateTokens(
  inputTokensEstimate: number | undefined,
  maxOutputTokens: number,
): number {
  return (inputTokensEstimate ?? DEFAULT_INPUT_TOKENS) + maxOutputTokens;
}

/** Models routed to local runtimes (Ollama, etc.) skip static price-table checks. */
export function isPricingExemptModel(model: string): boolean {
  return (
    model.startsWith("ollama/") ||
    model.startsWith("local/") ||
    !model.includes("/")
  );
}

/** Collect every provider model string referenced in a parsed config. */
export function collectConfiguredModels(config: ModelgovConfig): string[] {
  const models = new Set<string>();
  for (const cls of Object.values(config.modelClasses)) {
    models.add(cls.primary);
    if (cls.fallback) models.add(cls.fallback);
  }
  if (config.safety.injectionModel) {
    models.add(config.safety.injectionModel);
  }
  return [...models];
}

/**
 * Models missing from PRICE_TABLE (and not pricing-exempt). Used at API boot to
 * warn operators that budget reservations may be inaccurate.
 */
export function findUnpricedModels(config: ModelgovConfig): string[] {
  const custom = config.pricing ?? {};
  return collectConfiguredModels(config).filter(
    (model) => !isPricingExemptModel(model) && !(model in PRICE_TABLE) && !(model in custom),
  );
}
