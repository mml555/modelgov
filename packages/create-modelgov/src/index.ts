#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cancel, confirm, group, intro, isCancel, multiselect, note, outro, select, text } from "@clack/prompts";
import { buildScaffold, type ProjectOptions } from "./scaffold";
import type { DeployMode, Provider, SafetyPreset } from "./render";
import type { Framework } from "./adapters";
import { TEMPLATES, TEMPLATE_IDS, type TemplateId } from "./templates";

interface Flags {
  name?: string;
  framework?: Framework;
  template?: TemplateId;
  providers?: Provider[];
  safety?: SafetyPreset;
  mode?: DeployMode;
  yes?: boolean;
  dir?: string;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => argv[++i];
    if (a === "--yes" || a === "-y") f.yes = true;
    else if (a === "--name") f.name = val();
    else if (a === "--framework") f.framework = val() as Framework;
    else if (a === "--template") f.template = val() as TemplateId;
    else if (a === "--provider" || a === "--providers") f.providers = (val() ?? "").split(",").map((s) => s.trim()).filter(Boolean) as Provider[];
    else if (a === "--safety") f.safety = val() as SafetyPreset;
    else if (a === "--mode") f.mode = val() as DeployMode;
    else if (!a.startsWith("-")) f.dir = a;
  }
  return f;
}

/** Non-interactive resolution when enough flags are given (scripts / CI). */
function resolveNonInteractive(flags: Flags): ProjectOptions | null {
  if (!flags.template) return null;
  const template = TEMPLATES[flags.template];
  if (!template) throw new Error(`unknown template '${flags.template}' (one of: ${TEMPLATE_IDS.join(", ")})`);
  return {
    projectName: flags.name ?? "my-app",
    framework: flags.framework ?? "none",
    template,
    providers: template.localOnly ? [] : flags.providers ?? ["openai"],
    safetyPreset: flags.safety ?? "balanced",
    mode: flags.mode ?? "simple",
  };
}

async function promptOptions(flags: Flags): Promise<ProjectOptions> {
  intro("create-modelgov");
  const answers = await group(
    {
      projectName: () => text({ message: "Project name", placeholder: "my-app", defaultValue: flags.name ?? "my-app" }),
      framework: () =>
        select({
          message: "Framework?",
          options: [
            { value: "nextjs", label: "Next.js (App Router)" },
            { value: "express", label: "Express" },
            { value: "fastify", label: "Fastify" },
            { value: "fastapi", label: "FastAPI (Python)" },
            { value: "none", label: "None / other (config + compose only)" },
          ],
          initialValue: flags.framework ?? "nextjs",
        }),
      template: () =>
        select({
          message: "What AI feature? (template)",
          options: TEMPLATE_IDS.map((id) => ({ value: id, label: TEMPLATES[id].label })),
          initialValue: flags.template ?? "support_chat",
        }),
      providers: () =>
        multiselect({
          message: "Which provider(s)? (skipped for the local template)",
          options: [
            { value: "openai", label: "OpenAI" },
            { value: "anthropic", label: "Anthropic" },
            { value: "gemini", label: "Gemini" },
            { value: "openrouter", label: "OpenRouter" },
            { value: "azure", label: "Azure OpenAI" },
          ],
          initialValues: flags.providers ?? ["openai"],
          required: false,
        }),
      safety: () =>
        select({
          message: "Default safety preset",
          options: [
            { value: "balanced", label: "balanced (mask PII, block injection)" },
            { value: "strict", label: "strict (block PII, block injection)" },
            { value: "dev", label: "dev (no enforcement)" },
          ],
          initialValue: flags.safety ?? "balanced",
        }),
      mode: () =>
        select({
          message: "Deploy mode",
          options: [
            { value: "simple", label: "simple (API + LiteLLM + Postgres + Presidio)" },
            { value: "full", label: "full (+ Langfuse)" },
          ],
          initialValue: flags.mode ?? "simple",
        }),
    },
    { onCancel: () => { cancel("Cancelled."); process.exit(0); } },
  );

  const template = TEMPLATES[answers.template as TemplateId];
  const providers = (answers.providers as Provider[]) ?? [];
  return {
    projectName: answers.projectName,
    framework: answers.framework as Framework,
    template,
    providers: template.localOnly ? [] : providers.length ? providers : ["openai"],
    safetyPreset: answers.safety as SafetyPreset,
    mode: answers.mode as DeployMode,
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const targetDir = resolve(flags.dir ?? ".");

  const opts = resolveNonInteractive(flags) ?? (await promptOptions(flags));
  const files = buildScaffold(opts);

  // Refuse to clobber unless --yes or the user confirms.
  const existing = [...files.keys()].filter((p) => existsSync(join(targetDir, p)));
  if (existing.length > 0 && !flags.yes) {
    const ok = await confirm({ message: `Overwrite ${existing.length} existing file(s) in ${targetDir}?`, initialValue: false });
    if (isCancel(ok) || !ok) {
      cancel("Left existing files untouched.");
      process.exit(0);
    }
  }

  for (const [rel, content] of files) {
    const full = join(targetDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  const lines = [
    `Scaffolded ${files.size} files into ${targetDir}`,
    "",
    "Next:",
    `  1. Set your provider key in .env${opts.template.localOnly ? " (local template: none needed)" : ""}`,
    "  2. Set the api image in docker-compose.yml, then: docker compose up -d",
    "  3. Smoke test: node scripts/smoke.mjs",
  ];
  if (typeof note === "function") note(lines.join("\n"), "Done");
  if (typeof outro === "function") outro("Modelgov is ready to enforce your AI policy.");
}

void main();