import { apiFetch, ApiError } from "./client";

export interface SetupStatus {
  /** The setup API is available (dev/non-production console). */
  enabled: boolean;
  /** A real, operator-applied policy is active (not just the bootstrap seed). */
  configured: boolean;
}

/**
 * Whether first-run setup is still needed, from the server (not per-browser
 * localStorage). A 404 means the setup API is disabled (production console), so
 * the wizard must not be shown at all. Any other failure is treated the same —
 * fail safe by NOT forcing the wizard.
 */
export async function fetchSetupStatus(): Promise<SetupStatus> {
  try {
    return await apiFetch<SetupStatus>("/v1/setup/status");
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { enabled: false, configured: false };
    // Unknown/transient error: don't force the wizard (and risk clobbering policy).
    return { enabled: false, configured: true };
  }
}

export interface SetupSecretsResult {
  ok: boolean;
  savedKeys: string[];
  litellmConfigPath?: string;
  restarted?: boolean;
  nextCommand?: string;
  message: string;
}

export function saveSetupSecrets(
  secrets: Record<string, string>,
  options: { useCloud: boolean; litellmYaml?: string },
): Promise<SetupSecretsResult> {
  return apiFetch<SetupSecretsResult>("/v1/setup/secrets", {
    method: "POST",
    body: JSON.stringify({
      secrets,
      useCloud: options.useCloud,
      litellmYaml: options.litellmYaml,
    }),
  });
}

/**
 * Merge boot-only policy fields (routing.retry, pricing, safety.injection_model,
 * billing) from the active version into the wizard's generated config, so the
 * stored policy matches the running gateway instead of silently dropping them.
 * Returns the generated YAML unchanged when there is no active version.
 */
export async function mergeSetupPolicy(yaml: string): Promise<string> {
  const res = await apiFetch<{ yaml: string }>("/v1/setup/policy/merge", {
    method: "POST",
    body: JSON.stringify({ yaml }),
  });
  return res.yaml;
}
