#!/usr/bin/env tsx
/**
 * CI guard: a filled-in .env.production.example must pass production deploy
 * checks, and known dev keys must fail when MODELGOV_PRODUCTION=true.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertProductionDeploy, securityConfigWarnings } from "../packages/cli/src/ops.js";

const ROOT = resolve(import.meta.dirname, "..");
const EXAMPLE = resolve(ROOT, ".env.production.example");

function parseEnvExample(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return out;
}

function fillProductionExample(raw: Record<string, string>): Record<string, string> {
  const env = { ...raw };
  env.MODELGOV_PRODUCTION = "true";
  env.MODELGOV_API_KEY = "sk-production-example-" + "x".repeat(32);
  env.DATABASE_SSL = "require";
  env.METRICS_ENABLED = "true";
  env.METRICS_AUTH_TOKEN = "metrics-token-" + "y".repeat(32);
  env.DATABASE_URL = "postgres://postgres:secret@postgres:5432/modelgov";
  env.LITELLM_MASTER_KEY = "litellm-" + "z".repeat(32);
  return env;
}

const raw = parseEnvExample(readFileSync(EXAMPLE, "utf8"));
const filled = fillProductionExample(raw);

assertProductionDeploy(filled);
const warns = securityConfigWarnings(filled).filter((l) => l.startsWith("warn "));
if (warns.length > 0) {
  console.warn("production example warnings (non-blocking):\n" + warns.map((w) => `  ${w}`).join("\n"));
}

const bad = { ...filled, MODELGOV_API_KEY: "sk-modelgov-api-local" };
let rejected = false;
try {
  assertProductionDeploy(bad);
} catch {
  rejected = true;
}
if (!rejected) {
  console.error("expected assertProductionDeploy to reject known dev API key");
  process.exit(1);
}

console.log("ok production example passes doctor deploy checks");
