import { dirname, resolve } from "node:path";

/**
 * Compose project-name handling and the cross-checkout collision guard.
 *
 * Every compose file declares `name: modelgov`, so TWO checkouts of this repo
 * address the SAME docker-compose project. That is fine for `up`/`status`, but a
 * destructive command (`down -v` via `modelgov reset`) run from checkout B will
 * remove checkout A's containers AND its Postgres volume — the data loss happens
 * in a directory the operator never mentioned. Compose gives no warning: the
 * project name matches, so it treats those containers as its own.
 *
 * `COMPOSE_PROJECT_NAME` already overrides the `name:` attribute (compose
 * precedence: -p flag > COMPOSE_PROJECT_NAME > name: > directory basename), so
 * the escape hatch exists — it is just undiscoverable. This module makes the
 * collision loud instead of silent, and points at that env var.
 */

/** The `name:` declared by every local compose file in this repo. */
export const DEFAULT_COMPOSE_PROJECT = "modelgov";

/** `name:` declared by docker-compose.production.yml — a SEPARATE project. */
export const PROD_COMPOSE_PROJECT = "modelgov-prod";

/**
 * Effective compose project for this invocation (env override wins, as compose
 * does). `prod` is its own project, so the guard must query that one — checking
 * `modelgov` while tearing down `modelgov-prod` would compare the wrong
 * containers and could refuse (or allow) for the wrong reason.
 */
export function composeProjectName(
  env: NodeJS.ProcessEnv = process.env,
  mode?: string,
): string {
  const override = env.COMPOSE_PROJECT_NAME?.trim();
  if (override) return override;
  return mode === "prod" ? PROD_COMPOSE_PROJECT : DEFAULT_COMPOSE_PROJECT;
}

/**
 * Checkout directories OTHER than `root` that own containers in this project.
 *
 * `labels` are raw `com.docker.compose.project.config_files` values, one per
 * container; each is a comma-separated list of absolute compose-file paths, so a
 * container's owning checkout is the directory holding those files.
 */
export function foreignCheckoutDirs(labels: readonly string[], root: string): string[] {
  const here = resolve(root);
  const dirs = new Set<string>();
  for (const label of labels) {
    for (const file of label.split(",")) {
      const trimmed = file.trim();
      if (!trimmed) continue;
      const dir = dirname(resolve(trimmed));
      if (dir !== here) dirs.add(dir);
    }
  }
  return [...dirs].sort();
}

/** Actionable refusal explaining whose containers would have been destroyed. */
export function foreignCheckoutMessage(
  project: string,
  dirs: readonly string[],
  root: string,
  command: string,
): string {
  return [
    `Refusing to run \`${command}\` on compose project '${project}'.`,
    "",
    `Its containers were created from a different checkout:`,
    ...dirs.map((d) => `  ${d}`),
    `but you are running from:`,
    `  ${resolve(root)}`,
    "",
    "Both use the same compose project name, so this would remove the OTHER",
    "checkout's containers and volumes (including its Postgres data).",
    "",
    "Give this checkout its own project name, then retry:",
    `  COMPOSE_PROJECT_NAME=${project}-$(basename "$PWD") pnpm modelgov ...`,
    "",
    "Or run the command from the checkout that owns the stack.",
  ].join("\n");
}

/** Compose subcommands that can destroy another checkout's containers/volumes. */
export function isDestructiveComposeCommand(command: readonly string[]): boolean {
  return command.includes("down");
}

/** True when the command destroys volumes (`down -v`), not just containers. */
export function removesVolumes(command: readonly string[]): boolean {
  return command.includes("-v") || command.includes("--volumes");
}

/**
 * `docker ps` exposes labels as a STRING, so `{{index .Labels "k"}}` is a
 * template error — the per-label accessor is the `.Label` function. Getting this
 * wrong once already made the guard silently pass; keep the two facts together.
 */
export const CONFIG_FILES_FORMAT = '{{.Label "com.docker.compose.project.config_files"}}';

/**
 * Guard a destructive compose command. `capture` runs a command and returns its
 * stdout (injected so this stays unit-testable and this module stays free of
 * child_process).
 *
 * On a query failure we cannot prove ownership. For a volume-destroying command
 * that is NOT a reason to proceed — the whole point is to prevent unrecoverable
 * loss — so `-v` fails CLOSED with an override hint, while a plain `down`
 * (containers only, recreatable) fails open and lets compose report the problem.
 * An earlier version failed open unconditionally, which is exactly how a broken
 * query turned into a no-op guard.
 */
export async function assertProjectOwnedByThisCheckout(opts: {
  command: readonly string[];
  root: string;
  capture: (command: string, args: string[]) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  /** Deploy mode — `prod` lives in its own compose project. */
  mode?: string;
}): Promise<void> {
  const { command, root, capture } = opts;
  if (!isDestructiveComposeCommand(command)) return;
  const project = composeProjectName(opts.env, opts.mode);
  const rendered = `docker compose ${command.join(" ")}`;

  let out: string;
  try {
    out = await capture("docker", [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      CONFIG_FILES_FORMAT,
    ]);
  } catch (err) {
    // Fail CLOSED for every destructive command, not just volume removal. If
    // the ownership query fails for a reason that does not equally stop
    // `docker compose down`, proceeding would tear down another checkout's
    // running stack — recoverable, but still an outage someone did not ask for.
    const stakes = removesVolumes(command)
      ? "delete another checkout's containers AND volumes"
      : "tear down another checkout's running stack";
    throw new Error(
      `Refusing to run \`${rendered}\`: could not determine which checkout owns ` +
        `compose project '${project}', so this might ${stakes}.\n` +
        `  ${String(err).split("\n")[0]}\n\n` +
        `Re-run once docker is reachable, or scope this checkout explicitly:\n` +
        `  COMPOSE_PROJECT_NAME=${project}-$(basename "$PWD") pnpm modelgov ...`,
    );
  }

  const labels = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const foreign = foreignCheckoutDirs(labels, root);
  if (foreign.length > 0) {
    throw new Error(foreignCheckoutMessage(project, foreign, root, rendered));
  }
}
