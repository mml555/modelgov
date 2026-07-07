import { copyFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import { resolveUserPath } from "./paths.js";

export type OpsCommand =
  | "doctor"
  | "down"
  | "logs"
  | "reset"
  | "setup"
  | "smoke"
  | "status"
  | "up";

type Mode = "simple" | "full" | "local" | "cloud" | "prod";

interface OpsFlags {
  mode: Mode;
  yes: boolean;
  follow: boolean;
  strict: boolean;
}

interface ModeConfig {
  apiPort: number;
  composeArgs: string[];
  envFile?: string;
}

// Ops commands act on the user's Modelgov project (compose files, .env, scripts),
// NOT on the installed CLI package. Resolve everything relative to the invocation
// cwd (INIT_CWD when run via a package manager, else process.cwd()). In the
// monorepo dev case cwd IS the repo root, so this keeps working there too.
const ROOT = resolveUserPath(".");
const LOCAL_API_KEY = "sk-modelgov-api-local";

const KNOWN_DEV_API_KEYS = new Set(["sk-modelgov-api-local", "smoke-test-key"]);

import { deployProfileChecks } from "@modelgov/policy-engine";

/**
 * Security posture checks for operator env files. Returns human-readable lines
 * (prefixed ok/warn/fail) suitable for `doctor` output.
 */
export function securityConfigWarnings(env: Record<string, string>): string[] {
  const lines: string[] = [];

  const apiKey = env.MODELGOV_API_KEY;
  if (apiKey && KNOWN_DEV_API_KEYS.has(apiKey)) {
    lines.push("warn API key is a known dev default — rotate before shared or staging deploys");
  }

  if (env.OIDC_ISSUER && env.OIDC_JWKS_URI && !env.OIDC_AUDIENCE && env.OIDC_AUDIENCE_OPTIONAL !== "true") {
    lines.push(
      "warn OIDC enabled without OIDC_AUDIENCE — set OIDC_AUDIENCE or OIDC_AUDIENCE_OPTIONAL=true (local dev only)",
    );
  }

  if (env.RATE_LIMIT_FAIL_OPEN === "true") {
    lines.push("warn RATE_LIMIT_FAIL_OPEN=true — rate limits are bypassed when Redis is unreachable");
  }

  for (const c of deployProfileChecks(env, { production: env.MODELGOV_PRODUCTION === "true" })) {
    if (c.severity === "pass") continue;
    lines.push(`${c.severity} ${c.message}`);
  }

  if (env.MODELGOV_PRODUCTION === "true") {
    if (env.DATABASE_SSL === "disable" && env.DATABASE_SSL_DISABLE_ALLOWED !== "true") {
      lines.push("fail DATABASE_SSL=disable is not permitted when MODELGOV_PRODUCTION=true (set DATABASE_SSL_DISABLE_ALLOWED=true only for bundled Postgres)");
    }
    if (env.METRICS_ENABLED === "true" && !env.METRICS_AUTH_TOKEN && env.METRICS_ALLOW_PUBLIC !== "true") {
      lines.push("fail METRICS_AUTH_TOKEN is required when METRICS_ENABLED=true in production (or METRICS_ALLOW_PUBLIC=true)");
    }
    if (apiKey && KNOWN_DEV_API_KEYS.has(apiKey)) {
      lines.push("fail known dev API key cannot be used with MODELGOV_PRODUCTION=true");
    }
    if (env.OBSERVABILITY_CAPTURE_CONTENT === "true" && env.OBSERVABILITY_CAPTURE_CONTENT_ALLOW !== "true") {
      lines.push("fail OBSERVABILITY_CAPTURE_CONTENT=true requires OBSERVABILITY_CAPTURE_CONTENT_ALLOW=true in production");
    }
    if (env.IDEMPOTENCY_CAPTURE_CONTENT === "true" && env.IDEMPOTENCY_CAPTURE_CONTENT_ALLOW !== "true") {
      lines.push("fail IDEMPOTENCY_CAPTURE_CONTENT=true requires IDEMPOTENCY_CAPTURE_CONTENT_ALLOW=true in production");
    }
    if (env.MODELGOV_BEHIND_PROXY === "true" && !env.TRUST_PROXY) {
      lines.push("fail MODELGOV_BEHIND_PROXY=true requires TRUST_PROXY");
    }
  }

  return lines;
}

/** Throw when env fails production deploy checks (lines prefixed with `fail`). */
export function assertProductionDeploy(env: Record<string, string>): void {
  const failures = securityConfigWarnings(env).filter((line) => line.startsWith("fail "));
  if (failures.length === 0) return;
  throw new Error(`production deploy checks failed:\n${failures.map((l) => `  ${l}`).join("\n")}`);
}

export async function runOps(command: OpsCommand, args: string[]): Promise<void> {
  const flags = parseOpsFlags(args);
  switch (command) {
    case "setup":
      await up(flags, { strictSmoke: true });
      return;
    case "up":
      await up(flags, { strictSmoke: false });
      return;
    case "down":
      await dockerCompose(flags.mode, ["down"]);
      return;
    case "logs":
      await dockerCompose(flags.mode, ["logs", flags.follow ? "-f" : "", "api"].filter(Boolean));
      return;
    case "status":
      await status(flags.mode);
      return;
    case "doctor":
      await doctor(flags.mode, flags.strict);
      return;
    case "smoke":
      await smoke(flags.mode, { strict: true });
      return;
    case "reset":
      await reset(flags);
      return;
  }
}

export function parseOpsFlags(args: string[]): OpsFlags {
  const flags: OpsFlags = { mode: "simple", yes: false, follow: true, strict: false };
  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
      continue;
    }
    if (arg === "--no-follow") {
      flags.follow = false;
      continue;
    }
    if (arg === "--strict") {
      flags.strict = true;
      continue;
    }
    if (isMode(arg)) {
      flags.mode = arg;
      continue;
    }
    throw new Error(`Unknown ops argument: ${arg}`);
  }
  return flags;
}

function isMode(value: string): value is Mode {
  return value === "simple" || value === "full" || value === "local" || value === "cloud" || value === "prod";
}

async function up(flags: OpsFlags, opts: { strictSmoke: boolean }): Promise<void> {
  if (flags.mode === "prod") {
    if (!existsSync(resolve(ROOT, "scripts/up-prod.sh"))) {
      throw new Error(
        `Could not find scripts/up-prod.sh in ${ROOT}. Run this from your Modelgov project directory.`,
      );
    }
    await run("bash", ["scripts/up-prod.sh"]);
    return;
  }

  ensureEnv(flags.mode);
  if (flags.mode === "local") {
    await ensureOllama();
  } else if (flags.mode === "cloud") {
    ensureProviderKeys();
  }

  console.log(`Starting Modelgov (${flags.mode})...`);
  await dockerCompose(flags.mode, ["up", "--build", "-d"]);
  await waitForReady(modeConfig(flags.mode).apiPort);
  await smoke(flags.mode, { strict: opts.strictSmoke });
  printSuccess(flags.mode);
}

function ensureEnv(mode: Mode): void {
  if (existsSync(resolve(ROOT, ".env"))) return;
  const template = mode === "cloud" ? ".env.example" : ".env.local.example";
  copyFileSync(resolve(ROOT, template), resolve(ROOT, ".env"));
  console.log(`Created .env from ${template}.`);
  if (mode === "simple" || mode === "full") {
    console.log("Default setup uses the built-in demo provider, so no cloud API keys are required.");
    return;
  }
  if (mode === "local") {
    console.log("Local mode uses Ollama. Keep the dummy provider keys in .env.");
    console.log("Run these once if needed:");
    console.log("  ollama pull llama3.2:1b");
    console.log("  ollama pull llama3.2:3b");
    return;
  }
  console.log("Add at least one provider key to .env, then rerun:");
  console.log(`  ${rerunCommand(mode)}`);
  console.log("Required for cloud:");
  console.log("  OPENAI_API_KEY=sk-...");
  console.log("  or ANTHROPIC_API_KEY=sk-ant-...");
  process.exit(0);
}

function ensureProviderKeys(): void {
  const env = readEnvFile(".env");
  const openAi = env.OPENAI_API_KEY;
  const anthropic = env.ANTHROPIC_API_KEY;
  if (isRealSecret(openAi) || isRealSecret(anthropic)) return;
  throw new Error(
    "Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env, then rerun. Use `./setup` for the zero-secret demo stack.",
  );
}

async function ensureOllama(): Promise<void> {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    if (res.ok) return;
  } catch {
    // handled below
  }
  throw new Error("Ollama is not reachable at http://localhost:11434. Start Ollama, then rerun `make start-local`.");
}

async function status(mode: Mode): Promise<void> {
  await dockerCompose(mode, ["ps"]);
  const port = modeConfig(mode).apiPort;
  await printEndpointStatus(port, "/health");
  await printEndpointStatus(port, "/ready");
}

async function doctor(mode: Mode, strict: boolean): Promise<void> {
  console.log("Modelgov doctor");
  await checkCommand("docker", ["--version"]);
  await checkCommand("docker", ["compose", "version"]);
  const envFile = mode === "prod" ? ".env.production" : ".env";
  const securityLines: string[] = [];
  if (mode !== "prod") {
    console.log(existsSync(resolve(ROOT, ".env")) ? "ok .env exists" : "missing .env; run `./setup`");
    if (mode === "simple" || mode === "full") {
      console.log("ok built-in demo provider mode (no cloud keys required)");
      if (existsSync(resolve(ROOT, ".env"))) {
        const env = readEnvFile(".env");
        securityLines.push(...securityConfigWarnings(env));
        for (const line of securityLines) console.log(line);
      }
    } else if (mode === "local") {
      await checkOllamaForDoctor();
    } else if (existsSync(resolve(ROOT, ".env"))) {
      const env = readEnvFile(".env");
      console.log(isRealSecret(env.OPENAI_API_KEY) || isRealSecret(env.ANTHROPIC_API_KEY)
        ? "ok provider key present"
        : "missing provider key; set OPENAI_API_KEY or ANTHROPIC_API_KEY");
      securityLines.push(...securityConfigWarnings(env));
      for (const line of securityLines) console.log(line);
    }
  } else if (existsSync(resolve(ROOT, envFile))) {
    const env = readEnvFile(envFile);
    securityLines.push(...securityConfigWarnings(env));
    for (const line of securityLines) console.log(line);
  }
  await status(mode);
  if (strict) {
    const failures = securityLines.filter((line) => line.startsWith("fail "));
    if (failures.length > 0) {
      throw new Error(`doctor --strict failed:\n${failures.map((l) => `  ${l}`).join("\n")}`);
    }
  }
}

async function smoke(mode: Mode, opts: { strict: boolean }): Promise<void> {
  const port = modeConfig(mode).apiPort;
  const apiKey = readEnvFile(mode === "prod" ? ".env.production" : ".env").MODELGOV_API_KEY ?? LOCAL_API_KEY;
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "setup-smoke",
      userType: "logged_in",
      feature: "support_chat",
      modelClass: "cheap",
      messages: [{ role: "user", content: "Say hello in one short sentence." }],
    }),
  });

  if (res.ok) {
    console.log("ok smoke chat succeeded");
    return;
  }

  const body = await res.text().catch(() => "");
  if (!opts.strict && (res.status === 403 || res.status === 502 || res.status === 503)) {
    console.log(`warn smoke chat reached Modelgov but returned ${res.status}`);
    if (body) console.log(body.slice(0, 500));
    return;
  }
  throw new Error(`Smoke chat failed with HTTP ${res.status}${body ? `: ${body.slice(0, 500)}` : ""}`);
}

async function reset(flags: OpsFlags): Promise<void> {
  if (!flags.yes) {
    throw new Error("Refusing to reset without --yes. This removes compose volumes and local .env.");
  }
  await dockerCompose(flags.mode, ["down", "-v", "--remove-orphans"]);
  const envPath = resolve(ROOT, flags.mode === "prod" ? ".env.production" : ".env");
  if (basename(envPath) === ".env" && existsSync(envPath)) {
    unlinkSync(envPath);
    console.log("Removed .env");
  }
}

async function dockerCompose(mode: Mode, command: string[]): Promise<void> {
  const config = modeConfig(mode);
  assertComposeFilesExist(config.composeArgs);
  const args = [
    ...(config.envFile ? ["--env-file", config.envFile] : []),
    ...config.composeArgs,
    ...command,
  ];
  await run("docker", ["compose", ...args]);
}

/**
 * Compose files are resolved relative to ROOT (the invocation cwd). If one is
 * missing, the user is almost certainly running the CLI outside their Modelgov
 * project directory — surface that instead of docker's opaque ENOENT.
 */
function assertComposeFilesExist(composeArgs: string[]): void {
  for (let i = 0; i < composeArgs.length; i++) {
    if (composeArgs[i] !== "-f") continue;
    const file = composeArgs[i + 1];
    if (!file || existsSync(resolve(ROOT, file))) continue;
    throw new Error(
      `Could not find ${file} in ${ROOT}. Run this from your Modelgov project directory ` +
        `(the folder that holds your docker-compose files), or scaffold one with \`modelgov init\`.`,
    );
  }
}

export function modeConfig(mode: Mode): ModeConfig {
  switch (mode) {
    case "full":
      return { apiPort: localPublicPort(3090), composeArgs: ["-f", "docker-compose.simple.yml", "-f", "docker-compose.dev.full.yml"] };
    case "local":
      return { apiPort: 3080, composeArgs: ["-f", "docker-compose.simple.yml", "-f", "docker-compose.local.yml"] };
    case "cloud":
      return { apiPort: localPublicPort(3090), composeArgs: ["-f", "docker-compose.simple.yml", "-f", "docker-compose.cloud.yml"] };
    case "prod":
      return { apiPort: Number(process.env.MODELGOV_PUBLIC_PORT ?? 3000), envFile: ".env.production", composeArgs: ["-f", "docker-compose.production.yml"] };
    case "simple":
      return { apiPort: localPublicPort(3090), composeArgs: ["-f", "docker-compose.simple.yml"] };
  }
}

function localPublicPort(defaultPort: number): number {
  const fromProcess = process.env.MODELGOV_PUBLIC_PORT;
  if (fromProcess) return Number(fromProcess);
  const fromEnvFile = readEnvFile(".env").MODELGOV_PUBLIC_PORT;
  return Number(fromEnvFile ?? defaultPort);
}

async function waitForReady(port: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ready`);
      const body = await res.json().catch(() => undefined) as {
        status?: string;
        checks?: { database?: string; litellm?: string; presidio?: string };
      } | undefined;
      if (
        res.ok &&
        body?.status === "ready" &&
        body.checks?.database === "ok" &&
        body.checks?.litellm !== "fail" &&
        body.checks?.presidio !== "fail"
      ) return;
    } catch {
      // retry below
    }
    await sleep(2000);
  }
  throw new Error(`API did not become ready at http://127.0.0.1:${port}/ready`);
}

async function printEndpointStatus(port: number, path: "/health" | "/ready"): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await res.text();
    const body = parseJson(text);
    const status = typeof body?.status === "string" ? body.status : undefined;
    const ok =
      res.ok &&
      ((path === "/health" && status === "ok") ||
        (path === "/ready" && (status === "ready" || status === "not_ready")));
    const summary = body ? JSON.stringify(body) : `non-json response: ${text.slice(0, 80).replace(/\s+/g, " ")}`;
    console.log(`${ok ? "ok" : "fail"} ${path} ${res.status} ${summary}`);
  } catch (err) {
    console.log(`fail ${path} ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function checkCommand(command: string, args: string[]): Promise<void> {
  try {
    const output = await runCapture(command, args);
    console.log(`ok ${output.trim().split("\n")[0]}`);
  } catch {
    console.log(`missing ${command} ${args.join(" ")}`);
  }
}

async function checkOllamaForDoctor(): Promise<void> {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    console.log(res.ok ? "ok Ollama reachable" : `fail Ollama returned ${res.status}`);
  } catch {
    console.log("missing Ollama at http://localhost:11434");
  }
}

function printSuccess(mode: Mode): void {
  const port = modeConfig(mode).apiPort;
  console.log("");
  console.log(`Modelgov API: http://localhost:${port}`);
  if (mode === "full") console.log("Langfuse UI: http://localhost:3001");
  console.log(`Status: ${rerunCommand("status", mode)}`);
  console.log(`Logs:   ${rerunCommand("logs", mode)}`);
  console.log(`Stop:   ${rerunCommand("down", mode)}`);
}

function rerunCommand(commandOrMode: Mode | OpsCommand, mode?: Mode): string {
  if (commandOrMode === "simple") return "make start";
  if (commandOrMode === "full") return "make start-full";
  if (commandOrMode === "local") return "make start-local";
  if (commandOrMode === "cloud") return "make start-cloud";
  if (commandOrMode === "prod") return "make up-prod";
  const suffix = mode && mode !== "simple" ? `-${mode}` : "";
  if (commandOrMode === "up") return mode && mode !== "simple" ? `make start${suffix}` : "make start";
  if (commandOrMode === "down") return mode && mode !== "simple" ? `make stop${suffix}` : "make stop";
  return `make ${commandOrMode}${suffix}`;
}

function readEnvFile(path: string): Record<string, string> {
  const fullPath = resolve(ROOT, path);
  if (!existsSync(fullPath)) return {};
  const text = readFileSync(fullPath, "utf8");
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

function isRealSecret(value: string | undefined): boolean {
  if (!value) return false;
  return !value.includes("...") && !value.includes("REPLACE") && value.trim().length > 6;
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)));
    child.on("error", reject);
  });
}

async function runCapture(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("exit", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(stderr)));
    child.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
