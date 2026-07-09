import { apiFetch } from "./client";

export interface SetupSecretsResult {
  ok: boolean;
  savedKeys: string[];
  litellmConfigPath?: string;
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
