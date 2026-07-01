import { copyFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";

export type OpsCommand =
  | "doctor"
  | "down"
  | "logs"
  | "reset"
  | "setup"
  | "smoke"
  | "status"
  | "up";

type Mode = "simple" | "full" | "local" | "prod";

interface OpsFlags {
  mode: Mode;
  yes: boolean;
  follow: boolean;
}

interface ModeConfig {
  apiPort: number;
  composeArgs: string[];
  envFile?: string;
}

const ROOT = resolve(import.meta.dirname, "../../..");
const LOCAL_API_KEY = "sk-ai-guard-api-local";

export async function runOps(command: OpsCommand, args: string[]): Promise<void> {
  const flags = parseOpsFlags(args);
  switch (command) {
    case "setup":
    case "up":
      await up(flags);
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
      await doctor(flags.mode);
      return;
    case "smoke":
      await smoke(flags.mode, { strict: true });
      return;
    case "reset":
      await reset(flags);
      return;
  }
}

function parseOpsFlags(args: string[]): OpsFlags {
  const flags: OpsFlags = { mode: "simple", yes: false, follow: true };
  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
      continue;
    }
    if (arg === "--no-follow") {
      flags.follow = false;
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
  return value === "simple" || value === "full" || value === "local" || value === "prod";
}

async function up(flags: OpsFlags): Promise<void> {
  if (flags.mode === "prod") {
    await run("bash", ["scripts/up-prod.sh"]);
    return;
  }

  ensureEnv(flags.mode);
  if (flags.mode === "local") {
    await ensureOllama();
  } else {
    ensureProviderKeys();
  }

  console.log(`Starting Ai-Guard (${flags.mode})...`);
  await dockerCompose(flags.mode, ["up", "--build", "-d"]);
  await waitForReady(modeConfig(flags.mode).apiPort);
  await smoke(flags.mode, { strict: false });
  printSuccess(flags.mode);
}

function ensureEnv(mode: Mode): void {
  if (existsSync(resolve(ROOT, ".env"))) return;
  copyFileSync(resolve(ROOT, ".env.example"), resolve(ROOT, ".env"));
  console.log("Created .env from .env.example.");
  if (mode === "local") {
    console.log("Local mode uses Ollama. Keep the dummy provider keys in .env.");
    console.log("Run these once if needed:");
    console.log("  ollama pull llama3.2:1b");
    console.log("  ollama pull llama3.2:3b");
    return;
  }
  console.log("Add at least one provider key to .env, then rerun:");
  console.log(`  ${rerunCommand(mode)}`);
  console.log("Required for simple/full:");
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
    "Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env, then rerun. Use `make up-local` for Ollama-only setup.",
  );
}

async function ensureOllama(): Promise<void> {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    if (res.ok) return;
  } catch {
    // handled below
  }
  throw new Error("Ollama is not reachable at http://localhost:11434. Start Ollama, then rerun `make up-local`.");
}

async function status(mode: Mode): Promise<void> {
  await dockerCompose(mode, ["ps"]);
  const port = modeConfig(mode).apiPort;
  await printEndpointStatus(port, "/health");
  await printEndpointStatus(port, "/ready");
}

async function doctor(mode: Mode): Promise<void> {
  console.log("Ai-Guard doctor");
  await checkCommand("docker", ["--version"]);
  await checkCommand("docker", ["compose", "version"]);
  if (mode !== "prod") {
    console.log(existsSync(resolve(ROOT, ".env")) ? "ok .env exists" : "missing .env; run `make setup`");
    if (mode === "local") {
      await checkOllamaForDoctor();
    } else if (existsSync(resolve(ROOT, ".env"))) {
      const env = readEnvFile(".env");
      console.log(isRealSecret(env.OPENAI_API_KEY) || isRealSecret(env.ANTHROPIC_API_KEY)
        ? "ok provider key present"
        : "missing provider key; set OPENAI_API_KEY or ANTHROPIC_API_KEY");
    }
  }
  await status(mode);
}

async function smoke(mode: Mode, opts: { strict: boolean }): Promise<void> {
  const port = modeConfig(mode).apiPort;
  const apiKey = readEnvFile(mode === "prod" ? ".env.production" : ".env").AI_GUARD_API_KEY ?? LOCAL_API_KEY;
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
    console.log(`warn smoke chat reached Ai-Guard but returned ${res.status}`);
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
  const args = [
    ...(config.envFile ? ["--env-file", config.envFile] : []),
    ...config.composeArgs,
    ...command,
  ];
  await run("docker", ["compose", ...args]);
}

function modeConfig(mode: Mode): ModeConfig {
  switch (mode) {
    case "full":
      return { apiPort: 3000, composeArgs: ["-f", "docker-compose.simple.yml", "-f", "docker-compose.dev.full.yml"] };
    case "local":
      return { apiPort: 3080, composeArgs: ["-f", "docker-compose.simple.yml", "-f", "docker-compose.local.yml"] };
    case "prod":
      return { apiPort: Number(process.env.AI_GUARD_PUBLIC_PORT ?? 3000), envFile: ".env.production", composeArgs: ["-f", "docker-compose.production.yml"] };
    case "simple":
      return { apiPort: 3000, composeArgs: ["-f", "docker-compose.simple.yml"] };
  }
}

async function waitForReady(port: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ready`);
      const body = await res.json().catch(() => undefined) as { status?: string } | undefined;
      if (res.ok && body?.status === "ready") return;
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
  console.log(`Ai-Guard API: http://localhost:${port}`);
  if (mode === "full") console.log("Langfuse UI: http://localhost:3001");
  console.log(`Status: ${rerunCommand("status")}`);
  console.log(`Logs:   ${rerunCommand("logs", mode)}`);
  console.log(`Stop:   ${rerunCommand("down", mode)}`);
}

function rerunCommand(commandOrMode: Mode | OpsCommand, mode?: Mode): string {
  if (commandOrMode === "simple") return "make up";
  if (commandOrMode === "full") return "make up-full";
  if (commandOrMode === "local") return "make up-local";
  if (commandOrMode === "prod") return "make up-prod";
  const suffix = mode && mode !== "simple" ? `-${mode}` : "";
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
