import { readFileSync } from "node:fs";

/**
 * Secrets-manager integration via the `*_FILE` convention.
 *
 * Any env var `X` can instead be supplied as `X_FILE=/path/to/secret`; at boot
 * we read the file and populate `X`. This is the common integration point for
 * HashiCorp Vault Agent, the AWS/GCP/Azure Secrets Store CSI drivers, Kubernetes
 * Secrets, and Docker secrets — all of which mount secret material as files —
 * so no cloud SDK dependency is needed and long-lived secrets never sit in the
 * process environment or compose files.
 *
 * An explicitly-set `X` wins over `X_FILE` (so local overrides still work). A
 * declared `X_FILE` that can't be read is a hard boot error — failing fast is
 * safer than silently starting without a credential.
 */
export function expandFileSecrets(
  raw: NodeJS.ProcessEnv,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): NodeJS.ProcessEnv {
  const out = { ...raw };
  for (const key of Object.keys(raw)) {
    if (!key.endsWith("_FILE")) continue;
    const base = key.slice(0, -"_FILE".length);
    if (!base) continue;
    const path = raw[key];
    if (!path) continue;
    // Explicit value wins; don't clobber it with the file.
    if (out[base] !== undefined && out[base] !== "") continue;
    try {
      out[base] = readFile(path).trim();
    } catch (err) {
      throw new Error(
        `failed to read secret file for ${base} (${key}=${path}): ${(err as Error).message}`,
      );
    }
  }
  return out;
}
