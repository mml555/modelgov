import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cancel, confirm, group, intro, isCancel, multiselect, note, outro, select, text } from "@clack/prompts";
import { PROVIDER_REGISTRY } from "@modelgov/policy-engine";
import { buildScaffold, type ProjectOptions } from "./scaffold";
import { WIZARD_PROVIDERS, type DeployMode, type Provider, type SafetyPreset } from "./render";
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

export function parseFlags(argv: string[]): Flags {
  const f: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // Reject a missing value instead of swallowing the next flag: `--name --yes`
    // would otherwise set name to "--yes" AND silently drop --yes, scaffolding a
    // project with a nonsense name. Mirrors requireValue() in @modelgov/cli.
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v === "" || v.startsWith("-")) {
        throw new Error(`${a} requires a value`);
      }
      return v;
    };
    if (a === "--yes" || a === "-y") f.yes = true;
    else if (a === "--name") f.name = val();
    else if (a === "--framework") f.framework = val() as Framework;
    else if (a === "--template") f.template = val() as TemplateId;
    else if (a === "--provider" || a === "--providers") f.providers = val().split(",").map((s) => s.trim()).filter(Boolean) as Provider[];
    else if (a === "--safety") f.safety = val() as SafetyPreset;
    else if (a === "--mode") f.mode = val() as DeployMode;
    else if (!a.startsWith("-")) f.dir = a;
  }
  return f;
}

const FRAMEWORKS: readonly Framework[] = ["nextjs", "express", "fastify", "fastapi", "none"];
const SAFETY_PRESETS: readonly SafetyPreset[] = ["dev", "balanced", "strict"];
const DEPLOY_MODES: readonly DeployMode[] = ["simple", "full"];

/**
 * Reject an unrecognised flag value instead of casting it through.
 *
 * `--framework next` (a plausible typo for `nextjs`) used to reach `adapterFor`,
 * which has no default case, and crash with "Cannot read properties of
 * undefined (reading 'files')". Worse, `--safety bogus` SUCCEEDED and wrote
 * `preset: bogus` straight into modelgov.yaml — a scaffold that looks fine and
 * fails at gateway boot. Both are exactly the "misconfigures every new install"
 * failure this package is measured to prevent.
 */
function oneOf<T extends string>(value: string, valid: readonly T[], flag: string): T {
  if ((valid as readonly string[]).includes(value)) return value as T;
  throw new Error(`unknown ${flag} '${value}' (one of: ${valid.join(", ")})`);
}

/** Non-interactive resolution when enough flags are given (scripts / CI). */
/**
 * Reject any bad flag value the caller supplied, whether or not enough flags
 * were given to skip the wizard.
 *
 * Validating inside resolveNonInteractive's post-template path meant
 * `--framework next` with NO `--template` returned early and fell through to
 * the interactive wizard, where the bad value crashed later in the scaffolder —
 * the very failure the validation was added to prevent.
 */
export function validateFlags(flags: Flags): void {
  // `!== undefined`, not truthiness: "" is a SUPPLIED value, and skipping it
  // here would let `--framework ""` fall through to the default instead of
  // reporting the malformed command. (parseFlags also rejects an empty value,
  // so this is the second line of defence for direct callers.)
  if (flags.framework !== undefined) oneOf(flags.framework, FRAMEWORKS, "framework");
  if (flags.safety !== undefined) oneOf(flags.safety, SAFETY_PRESETS, "safety preset");
  if (flags.mode !== undefined) oneOf(flags.mode, DEPLOY_MODES, "mode");
  for (const p of flags.providers ?? []) oneOf(p, WIZARD_PROVIDERS, "provider");
}

export function resolveNonInteractive(flags: Flags): ProjectOptions | null {
  validateFlags(flags);
  if (!flags.template) return null;
  const template = TEMPLATES[flags.template];
  if (!template) throw new Error(`unknown template '${flags.template}' (one of: ${TEMPLATE_IDS.join(", ")})`);
  const framework = flags.framework ? oneOf(flags.framework, FRAMEWORKS, "framework") : "none";
  const safetyPreset = flags.safety ? oneOf(flags.safety, SAFETY_PRESETS, "safety preset") : "balanced";
  const mode = flags.mode ? oneOf(flags.mode, DEPLOY_MODES, "mode") : "simple";
  return {
    projectName: flags.name ?? "my-app",
    framework,
    template,
    providers: template.localOnly ? [] : flags.providers ?? ["openai"],
    safetyPreset,
    mode,
  };
}

export async function promptOptions(flags: Flags): Promise<ProjectOptions> {
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
          options: WIZARD_PROVIDERS.map((slug) => ({
            value: slug,
            label: PROVIDER_REGISTRY[slug]?.label ?? slug,
          })),
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

/**
 * The whole wizard. Exported and side-effect-free at import time — `index.ts` is
 * what actually invokes it. This module used to end in a bare top-level call to
 * it, so importing the module RAN the scaffolder; that is why none of this file
 * could be tested, and why the blanket index.ts coverage exclusion hid it.
 */
export async function main(): Promise<void> {
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
