import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { productionDoctorChecksFromEnv } from "./productionDoctorChecks.js";

const ROOT = resolve(import.meta.dirname, "../../..");

function parseEnvFile(path: string): Record<string, string> {
  const full = resolve(ROOT, path);
  if (!existsSync(full)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return out;
}

export interface DoctorProductionOptions {
  envFile?: string;
  strict?: boolean;
}

export function runDoctorProduction(opts: DoctorProductionOptions = {}): number {
  const envFile = opts.envFile ?? ".env.production";
  const env = parseEnvFile(envFile);
  env.MODELGOV_PRODUCTION = env.MODELGOV_PRODUCTION ?? "true";

  console.log("Modelgov production doctor");
  console.log(`  env file: ${envFile}`);
  console.log("");

  const checks = productionDoctorChecksFromEnv(env);
  let fails = 0;
  let warns = 0;

  for (const c of checks) {
    const prefix = c.severity === "pass" ? "ok  " : c.severity === "warn" ? "warn" : "FAIL";
    console.log(`${prefix} [${c.code}] ${c.message}`);
    if (c.fix) console.log(`       fix: ${c.fix}`);
    if (c.severity === "fail") fails++;
    if (c.severity === "warn") warns++;
  }

  console.log("");
  console.log(`Summary: ${checks.filter((c) => c.severity === "pass").length} pass, ${warns} warn, ${fails} fail`);

  if (fails > 0) {
    console.error("\nProduction doctor failed.");
    return 1;
  }
  if (opts.strict && warns > 0) {
    console.error("\nProduction doctor failed in --strict mode (warnings treated as errors).");
    return 1;
  }
  console.log("\nProduction doctor passed.");
  return 0;
}
