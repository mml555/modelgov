import { readFileSync } from "node:fs";
import {
  findUnpricedModels,
  parseConfig,
  providerCredentialEnvVars,
  type ModelgovConfig,
} from "@modelgov/policy-engine";

const ENV_PREFIX = "env/";

// `env/VAR` in a policy may only reference PROVIDER credentials, never gateway
// secrets. Otherwise a `policy:write` operator could point a provider api_key at
// e.g. env/STRIPE_SECRET_KEY or env/DATABASE_URL and — the moment any future
// endpoint echoes provider config — exfiltrate it. Default policy: names ending
// in _KEY are allowed (OPENAI_API_KEY, ANTHROPIC_API_KEY, AZURE_OPENAI_KEY, a
// custom MY_OPENAI_KEY, ...); credential vars of any registered provider are
// allowed even when they don't end in _KEY (Bedrock AWS_ACCESS_KEY_ID/
// AWS_SESSION_TOKEN/AWS_REGION_NAME, Vertex GOOGLE_APPLICATION_CREDENTIALS,
// Azure AZURE_API_BASE/AZURE_API_VERSION, Copilot GITHUB_COPILOT_TOKEN); an
// explicit allowlist can add still more; and a hardcoded set of known gateway
// secrets is always denied even when it would otherwise match. (Note: this only
// gates env/VAR refs written into modelgov.yaml — in the proxy deployment
// LiteLLM reads provider creds from its own environment, not through here.)
const PROVIDER_CRED_VARS = new Set(providerCredentialEnvVars());

const GATEWAY_SECRET_DENY = new Set([
  "DATABASE_URL",
  "DATABASE_SSL_CA",
  "LITELLM_MASTER_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "METRICS_AUTH_TOKEN",
  "BUDGET_ALERT_WEBHOOK_SECRET",
  "LANGFUSE_SECRET_KEY",
  "REDIS_URL",
  "MODELGOV_API_KEY",
  "MODELGOV_API_KEYS",
  "OIDC_ROLE_MAP",
]);

let explicitEnvRefAllow = new Set<string>();
/** Set once at boot from MODELGOV_POLICY_ENV_ALLOWLIST to extend the default. */
export function setPolicyEnvRefAllowlist(names: readonly string[]): void {
  explicitEnvRefAllow = new Set(names.map((n) => n.trim()).filter(Boolean));
}
function envRefAllowed(varName: string): boolean {
  if (GATEWAY_SECRET_DENY.has(varName)) return false; // deny always wins
  if (explicitEnvRefAllow.has(varName)) return true;
  if (PROVIDER_CRED_VARS.has(varName)) return true; // known provider credential
  return varName.endsWith("_KEY");
}

/**
 * Resolve `env/VAR` provider key references against the provided environment map. Done in the
 * API layer only — the pure engine never reads the environment. (Note: in the
 * LiteLLM-proxy deployment the proxy owns provider credentials; this is mostly
 * informational / for direct-SDK setups.)
 */
export function resolveEnvRefs(
  config: ModelgovConfig,
  envRefs: Record<string, string | undefined>,
  onMissing?: (varName: string, provider: string) => void,
): ModelgovConfig {
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.apiKey?.startsWith(ENV_PREFIX)) {
      const varName = provider.apiKey.slice(ENV_PREFIX.length);
      // Refuse to resolve a var outside the provider-credential allowlist: never
      // put a gateway secret into the config object, even in memory.
      if (!envRefAllowed(varName)) {
        onMissing?.(varName, name);
        provider.apiKey = undefined;
        continue;
      }
      // A referenced-but-unset (or blocked) var resolves to undefined — surface
      // it so a misconfigured provider key is a visible warning, not a mystery
      // empty credential.
      if (onMissing && envRefs[varName] === undefined) onMissing(varName, name);
      provider.apiKey = envRefs[varName];
    }
  }
  return config;
}

export function loadConfigFromFile(
  path: string,
  envRefs: Record<string, string | undefined>,
  options?: { strictPricing?: boolean; onMissingEnvRef?: (varName: string, provider: string) => void },
): ModelgovConfig {
  const text = readFileSync(path, "utf8");
  return resolveEnvRefs(parseConfig(text, options), envRefs, options?.onMissingEnvRef);
}

/** Log a startup warning when configured models lack static price entries. */
export function warnUnpricedModels(config: ModelgovConfig, log?: {
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
