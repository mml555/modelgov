// Static price table for cost *estimation* only. The reservation uses this
// estimate; the real cost returned by LiteLLM reconciles it after the call
// (recordActualCost). Prices are USD per 1K tokens. Keep keys aligned with the
// model strings used in `modelgov.yaml` model_classes.

import { providerOf } from "./routing";
import { buildBuiltinPriceTable, isSubscriptionModel } from "./providers";
import type { ModelgovConfig } from "./types";

export interface ModelPrice {
  inputPer1k: number;
  outputPer1k: number;
}

// The built-in table is assembled from the provider registry (providers.ts),
// which is the single source of truth for provider metadata + prices. Keys are
// full model strings, matching those used in `modelgov.yaml` model_classes.
export const PRICE_TABLE: Record<string, ModelPrice> = buildBuiltinPriceTable();

/** Conservative fallback when a model is not in the table. */
export const DEFAULT_PRICE: ModelPrice = { inputPer1k: 0.001, outputPer1k: 0.004 };

/** Subscription-billed models have no per-token cost, so they reserve $0 USD. */
export const SUBSCRIPTION_PRICE: ModelPrice = { inputPer1k: 0, outputPer1k: 0 };

/** Assumed input size when the caller provides no token estimate. */
export const DEFAULT_INPUT_TOKENS = 500;

/**
 * Resolve a model's price: config `pricing` override → subscription zero →
 * built-in table → conservative default. `overrides` come from `modelgov.yaml`'s
 * `pricing:`. An explicit override always wins (so an operator can price even a
 * subscription model if they really want); otherwise a subscription-billed model
 * (e.g. GitHub Copilot) resolves to $0 so no USD is reserved or settled for it —
 * token/request budgets still apply.
 */
export function getModelPrice(
  model: string,
  overrides?: Record<string, ModelPrice>,
): ModelPrice {
  const override = overrides?.[model];
  if (override) return override;
  if (isSubscriptionModel(model)) return SUBSCRIPTION_PRICE;
  return PRICE_TABLE[model] ?? DEFAULT_PRICE;
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

/**
 * Models exempt from static price-table checks: local runtimes (Ollama, etc.)
 * and subscription-billed providers (GitHub Copilot) — neither has a per-token
 * price to reconcile, so a missing PRICE_TABLE entry is expected, not a warning.
 */
export function isPricingExemptModel(model: string): boolean {
  return (
    model.startsWith("ollama/") ||
    model.startsWith("local/") ||
    !model.includes("/") ||
    isSubscriptionModel(model)
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
    (model) =>
      !isPricingExemptModel(model) &&
      // A provider an operator has marked `billing: subscription` reserves $0,
      // so a missing price is intentional, not a misconfiguration to warn about.
      config.providers[providerOf(model)]?.billing !== "subscription" &&
      !(model in PRICE_TABLE) &&
      !(model in custom),
  );
}
