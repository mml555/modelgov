import { PROVIDER_REGISTRY } from "@modelgov/policy-engine";
import { readEnvFile } from "./setupConfig.js";

// Credential gating for the cloud/azure stacks: decide whether .env holds a real
// provider credential before starting a stack that cannot work without one.
// Split out of ops.ts (which was at the 650-LOC limit); it depends only on the
// env file and the provider registry, so it stays independent of compose/ops.

// Known non-secret placeholders shipped in .env templates / scaffold hints. These
// are >6 chars and contain no "..."/"REPLACE", so without an explicit denylist
// they'd be mistaken for real credentials — e.g. `make start-cloud` on the demo
// .env would pass the credential gate and then 401 against the provider.
const PLACEHOLDER_SECRETS = new Set(["demo-unused", "demo-key", "changeme", "your-key-here"]);

export function isRealSecret(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (v.length <= 6) return false;
  if (v.includes("...") || v.includes("REPLACE")) return false;
  if (PLACEHOLDER_SECRETS.has(v)) return false;
  // Scaffold hints like `<your-resource>` and `/path/to/service-account.json`.
  if (v.includes("<") && v.includes(">")) return false;
  if (v.startsWith("/path/to/")) return false;
  return true;
}

/** True when .env contains at least one non-placeholder provider credential. */
export function hasAnyProviderCredentials(env: Record<string, string>): boolean {
  const optionalOnly = new Set(["AWS_SESSION_TOKEN", "GITHUB_COPILOT_TOKEN"]);
  for (const spec of Object.values(PROVIDER_REGISTRY)) {
    for (const key of spec.credentialEnvVars ?? []) {
      if (optionalOnly.has(key)) continue;
      if (isRealSecret(env[key])) return true;
    }
  }
  return false;
}

export function ensureProviderKeys(): void {
  if (hasAnyProviderCredentials(readEnvFile(".env"))) return;
  throw new Error(
    "Add a provider API key to .env (e.g. OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY), then rerun. Use `./setup` for the zero-secret demo stack.",
  );
}

export function ensureAzureKeys(): void {
  const env = readEnvFile(".env");
  const key = env.AZURE_API_KEY;
  const base = env.AZURE_API_BASE;
  const version = env.AZURE_API_VERSION;
  if (isRealSecret(key) && isRealSecret(base) && isRealSecret(version)) return;
  throw new Error(
    "Set AZURE_API_KEY, AZURE_API_BASE, and AZURE_API_VERSION in .env, then rerun. " +
      "Deployment names in modelgov.azure.example.yaml must match your Azure resource.",
  );
}
