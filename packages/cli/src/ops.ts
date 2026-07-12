import { PROVIDER_REGISTRY } from "@modelgov/policy-engine";
import { copyFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { resolveUserPath } from "./paths.js";
import {
  DEFAULT_CONSOLE_PORT,
  buildAutoconnectConsoleUrl,
  maybeOpenBrowser,
} from "./browserOpen.js";
import {
  assertLitellmConfigUsable,
  ensureGeneratedLitellmConfig,
  readEnvFile,
  runningOnSummary,
} from "./setupConfig.js";

import { securityConfigWarnings } from "./security.js";

// Re-exported so existing importers (and tests) keep a stable entry point.
export { assertLitellmConfigUsable, ensureGeneratedLitellmConfig } from "./setupConfig.js";
export { assertProductionDeploy, securityConfigWarnings } from "./security.js";

export interface SmokeChatPayload {
  feature: string;
  userType: string;
  modelClass: string;
}

export type OpsCommand =
  | "doctor"
  | "down"
  | "logs"
  | "reload-providers"
  | "reset"
  | "setup"
  | "smoke"
  | "status"
  | "up";

export type Mode = "simple" | "full" | "local" | "cloud" | "azure" | "prod";

interface OpsFlags {
  mode: Mode;
  yes: boolean;
  follow: boolean;
  strict: boolean;
  json: boolean;
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

export async function runOps(command: OpsCommand, args: string[]): Promise<void> {
  const flags = parseOpsFlags(args);
  switch (command) {
    case "setup":
      await up(flags, { strictSmoke: true, json: flags.json });
      return;
    case "up":
      await up(flags, { strictSmoke: false, json: flags.json });
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
    case "reload-providers":
      await reloadProviders();
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
  const flags: OpsFlags = { mode: "simple", yes: false, follow: true, strict: false, json: false };
  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
      continue;
    }
    if (arg === "--json") {
      flags.json = true;
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
  return value === "simple" || value === "full" || value === "local" || value === "cloud" || value === "azure" || value === "prod";
}

/** Console URL with ?url=&token= so the operator UI can auto-sign-in after setup. */
async function up(flags: OpsFlags, opts: { strictSmoke: boolean; json: boolean }): Promise<void> {
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
  } else if (flags.mode === "azure") {
    ensureAzureKeys();
  }

  ensureGeneratedLitellmConfig();
  assertLitellmConfigUsable();

  console.log(`Starting Modelgov (${flags.mode})...`);
  await dockerCompose(flags.mode, ["up", "--build", "-d"]);
  await waitForReady(modeConfig(flags.mode).apiPort);
  await smoke(flags.mode, { strict: opts.strictSmoke });
  printSuccess(flags.mode, opts.json);
}

function ensureEnv(mode: Mode): void {
  if (existsSync(resolve(ROOT, ".env"))) return;
  const template =
    mode === "cloud" ? ".env.example" : mode === "azure" ? ".env.azure.example" : ".env.local.example";
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
  console.log("Add provider credentials to .env, then rerun:");
  console.log(`  ${rerunCommand(mode)}`);
  if (mode === "azure") {
    console.log("Required for azure:");
    console.log("  AZURE_API_KEY=...");
    console.log("  AZURE_API_BASE=https://<resource>.openai.azure.com");
    console.log("  AZURE_API_VERSION=2024-08-01-preview");
  } else {
    console.log("Required for cloud:");
    console.log("  OPENAI_API_KEY=sk-...");
    console.log("  or ANTHROPIC_API_KEY=sk-ant-...");
  }
  process.exit(0);
}

function ensureProviderKeys(): void {
  if (hasAnyProviderCredentials(readEnvFile(".env"))) return;
  throw new Error(
    "Add a provider API key to .env (e.g. OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY), then rerun. Use `./setup` for the zero-secret demo stack.",
  );
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

async function reloadProviders(): Promise<void> {
  const env = readEnvFile(".env");
  if (!hasAnyProviderCredentials(env)) {
    throw new Error(
      "No provider credentials in .env. Paste keys in the setup wizard or add them to .env first.",
    );
  }
  const configPath = env.LITELLM_CONFIG_PATH ?? `./litellm_config.generated.yaml`;
  const relative = configPath.replace(/^\.\//, "");
  if (!existsSync(resolve(ROOT, relative))) {
    throw new Error(
      `Missing ${relative}. Finish the setup wizard's cloud-provider step first (it writes this file), or run make start-cloud.`,
    );
  }
  console.log("Reloading the model proxy with your provider keys...");
  await dockerCompose("simple", ["up", "-d", "litellm", "--force-recreate"]);
  await waitForReady(modeConfig("simple").apiPort);
  console.log("ok model proxy reloaded — real provider calls are enabled");
}

function ensureAzureKeys(): void {
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
      if (mode === "azure") {
        const azureOk =
          isRealSecret(env.AZURE_API_KEY) &&
          isRealSecret(env.AZURE_API_BASE) &&
          isRealSecret(env.AZURE_API_VERSION);
        console.log(azureOk
          ? "ok Azure credentials present"
          : "missing Azure credentials; set AZURE_API_KEY, AZURE_API_BASE, AZURE_API_VERSION");
      } else {
        console.log(hasAnyProviderCredentials(env)
          ? "ok provider credentials present"
          : "missing provider credentials — add a key from your AI provider to .env");
      }
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

/** Pick a valid feature/userType/modelClass from a modelgov.yaml document. */
export function smokePayloadFromPolicyYaml(yamlText: string): SmokeChatPayload {
  const doc = parseYaml(yamlText) as {
    features?: Record<string, { model_class?: string }>;
    budgets?: { by_user_type?: Record<string, { models?: string[] }> };
  };
  const featureNames = Object.keys(doc.features ?? {});
  if (featureNames.length === 0) {
    throw new Error("Policy has no features — cannot run smoke chat");
  }
  const feature = featureNames.includes("support_chat") ? "support_chat" : featureNames[0]!;
  const modelClass = doc.features?.[feature]?.model_class ?? "cheap";
  const byUserType = doc.budgets?.by_user_type ?? {};
  const userTypes = Object.keys(byUserType);
  const preferred = ["logged_in", "pro", "admin", "free", "anonymous"];
  const userType =
    preferred.find((u) => userTypes.includes(u) && byUserType[u]?.models?.includes(modelClass))
    ?? preferred.find((u) => userTypes.includes(u))
    ?? userTypes[0]
    ?? "logged_in";
  return { feature, userType, modelClass };
}

async function resolveSmokePayload(port: number, apiKey: string): Promise<SmokeChatPayload> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/admin/policy/active`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const body = await res.json() as { yaml?: string };
      if (body.yaml) return smokePayloadFromPolicyYaml(body.yaml);
    }
  } catch {
    // Fall back to the on-disk policy file.
  }
  const filePath = resolve(ROOT, "modelgov.yaml");
  if (!existsSync(filePath)) {
    return { feature: "support_chat", userType: "logged_in", modelClass: "cheap" };
  }
  return smokePayloadFromPolicyYaml(readFileSync(filePath, "utf8"));
}

async function smoke(mode: Mode, opts: { strict: boolean }): Promise<void> {
  const port = modeConfig(mode).apiPort;
  const apiKey = readEnvFile(mode === "prod" ? ".env.production" : ".env").MODELGOV_API_KEY ?? LOCAL_API_KEY;
  const payload = await resolveSmokePayload(port, apiKey);
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "setup-smoke",
      userType: payload.userType,
      feature: payload.feature,
      modelClass: payload.modelClass,
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
        `(the folder that holds your docker-compose files), or scaffold one with \`create-modelgov\`.`,
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
    case "azure":
      return { apiPort: localPublicPort(3090), composeArgs: ["-f", "docker-compose.simple.yml", "-f", "docker-compose.azure.yml"] };
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

function printSuccess(mode: Mode, json: boolean): void {
  const port = modeConfig(mode).apiPort;
  const env = readEnvFile(mode === "prod" ? ".env.production" : ".env");
  const apiKey = env.MODELGOV_API_KEY ?? LOCAL_API_KEY;
  const apiUrl = env.MODELGOV_URL ?? `http://localhost:${port}`;
  const consolePort = Number(env.MODELGOV_CONSOLE_PORT ?? DEFAULT_CONSOLE_PORT);
  const consoleUrl = buildAutoconnectConsoleUrl(apiUrl, apiKey, consolePort);

  if (json) {
    console.log(JSON.stringify({ status: "ready", consoleUrl }));
    return;
  }

  console.log("");
  console.log(`✓ Ready — ${runningOnSummary(mode)}`);
  const usesDemoBootstrap = mode === "simple" || mode === "full";
  const opened = maybeOpenBrowser(consoleUrl);
  if (usesDemoBootstrap) {
    // The simple/full stack boots on the built-in demo AI. The console link opens
    // a guided wizard that connects a REAL provider (OpenAI, Anthropic, Gemini,
    // …) in a couple of minutes — that is the point of opening it, not the demo.
    console.log(
      opened
        ? "  Opening the console to connect your AI provider… (if it doesn't open, click:)"
        : "  Open the console to connect your AI provider (or explore the demo):",
    );
  } else {
    console.log(
      opened
        ? "  Opening the operator console… (if it doesn't open, click:)"
        : "  Open the operator console:",
    );
  }
  console.log("");
  console.log(`  ${consoleUrl}`);
  console.log("");
  if (mode === "full") console.log("  Langfuse UI: http://localhost:3001");
  console.log(`  ${rerunCommand("status", mode)} · ${rerunCommand("down", mode)}`);
}

function rerunCommand(commandOrMode: Mode | OpsCommand, mode?: Mode): string {
  if (commandOrMode === "simple") return "make start";
  if (commandOrMode === "full") return "make start-full";
  if (commandOrMode === "local") return "make start-local";
  if (commandOrMode === "cloud") return "make start-cloud";
  if (commandOrMode === "reload-providers") return "pnpm modelgov reload-providers";
  if (commandOrMode === "azure") return "make start-azure";
  if (commandOrMode === "prod") return "make up-prod";
  const suffix = mode && mode !== "simple" ? `-${mode}` : "";
  if (commandOrMode === "up") return mode && mode !== "simple" ? `make start${suffix}` : "make start";
  if (commandOrMode === "down") return mode && mode !== "simple" ? `make stop${suffix}` : "make stop";
  return `make ${commandOrMode}${suffix}`;
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
