import { isAbsolute, resolve } from "node:path";

export function resolveUserPath(
  path: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (isAbsolute(path)) return path;
  return resolve(env.INIT_CWD ?? process.cwd(), path);
}
