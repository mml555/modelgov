import { readFileSync } from "node:fs";
import { findUnpricedModels, parseConfig, type AiGuardConfig } from "@ai-guard/policy-engine";

const ENV_PREFIX = "env/";

/**
 * Resolve `env/VAR` provider key references against the provided environment map. Done in the
 * API layer only — the pure engine never reads the environment. (Note: in the
 * LiteLLM-proxy deployment the proxy owns provider credentials; this is mostly
 * informational / for direct-SDK setups.)
 */
export function resolveEnvRefs(
  config: AiGuardConfig,
  envRefs: Record<string, string | undefined>,
): AiGuardConfig {
  for (const provider of Object.values(config.providers)) {
    if (provider.apiKey?.startsWith(ENV_PREFIX)) {
      const varName = provider.apiKey.slice(ENV_PREFIX.length);
      provider.apiKey = envRefs[varName];
    }
  }
  return config;
}

export function loadConfigFromFile(
  path: string,
  envRefs: Record<string, string | undefined>,
  options?: { strictPricing?: boolean },
): AiGuardConfig {
  const text = readFileSync(path, "utf8");
  return resolveEnvRefs(parseConfig(text, options), envRefs);
}

/** Log a startup warning when configured models lack static price entries. */
export function warnUnpricedModels(config: AiGuardConfig, log?: {
  warn(obj: unknown, msg: string): void;
}): void {
  const unpriced = findUnpricedModels(config);
  if (unpriced.length > 0) {
    log?.warn(
      { models: unpriced },
      "model(s) missing from PRICE_TABLE — budget reservations use DEFAULT_PRICE",
    );
  }
}
