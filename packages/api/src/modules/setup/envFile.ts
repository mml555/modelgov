import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Thrown when a key/value would corrupt the dotenv file (e.g. newline injection). */
export class EnvFileError extends Error {}

/** Merge key=value pairs into a dotenv file (create or update existing keys).
 *  Rejects invalid keys and values containing newlines — a value like
 *  `x\nMODELGOV_API_KEY=evil` would otherwise inject an extra line. */
export function mergeEnvFile(envPath: string, updates: Record<string, string>): void {
  for (const [key, value] of Object.entries(updates)) {
    if (!ENV_KEY_RE.test(key)) throw new EnvFileError(`Invalid env key: ${JSON.stringify(key)}`);
    if (/[\r\n]/.test(value)) throw new EnvFileError(`Env value for ${key} must not contain newlines`);
  }
  const fullPath = resolve(envPath);
  const lines = existsSync(fullPath) ? readFileSync(fullPath, "utf8").split(/\r?\n/) : [];
  const indexByKey = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    indexByKey.set(trimmed.slice(0, eq), i);
  }

  for (const [key, value] of Object.entries(updates)) {
    const next = `${key}=${value}`;
    const idx = indexByKey.get(key);
    if (idx !== undefined) lines[idx] = next;
    else lines.push(next);
  }

  const body = lines.join("\n");
  // 0o600: the file holds provider secrets — don't leave it world-readable.
  // (mode applies when the file is created; an existing file keeps its perms.)
  writeFileSync(fullPath, body.endsWith("\n") ? body : `${body}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
