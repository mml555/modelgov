import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Merge key=value pairs into a dotenv file (create or update existing keys). */
export function mergeEnvFile(envPath: string, updates: Record<string, string>): void {
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
  writeFileSync(fullPath, body.endsWith("\n") ? body : `${body}\n`, "utf8");
}
