import { describe, expect, it, vi } from "vitest";
import {
  CONFIG_FILES_FORMAT,
  DEFAULT_COMPOSE_PROJECT,
  assertProjectOwnedByThisCheckout,
  composeProjectName,
  foreignCheckoutDirs,
  PROD_COMPOSE_PROJECT,
  isDestructiveComposeCommand,
  removesVolumes,
} from "../src/composeProject.js";

// Regression cover for a real incident: every compose file hardcodes
// `name: modelgov`, so `down -v` run from a SECOND checkout removed the first
// checkout's containers and its Postgres volume. Compose itself gives no warning
// — the project name matches, so it treats those containers as its own.

const HERE = "/Users/dev/modelgov";
const OTHER = "/tmp/scratch-clone";
const label = (dir: string) =>
  `${dir}/docker-compose.simple.yml,${dir}/docker-compose.cloud.yml`;

describe("composeProjectName", () => {
  it("defaults to the name declared in the compose files", () => {
    expect(composeProjectName({})).toBe(DEFAULT_COMPOSE_PROJECT);
    expect(DEFAULT_COMPOSE_PROJECT).toBe("modelgov");
  });

  it("honors COMPOSE_PROJECT_NAME, which is what compose itself does", () => {
    expect(composeProjectName({ COMPOSE_PROJECT_NAME: "modelgov-scratch" })).toBe(
      "modelgov-scratch",
    );
  });

  it("treats an empty or whitespace override as unset", () => {
    expect(composeProjectName({ COMPOSE_PROJECT_NAME: "" })).toBe(DEFAULT_COMPOSE_PROJECT);
    expect(composeProjectName({ COMPOSE_PROJECT_NAME: "   " })).toBe(DEFAULT_COMPOSE_PROJECT);
  });
});

describe("isDestructiveComposeCommand", () => {
  it("flags every form of down", () => {
    expect(isDestructiveComposeCommand(["down"])).toBe(true);
    expect(isDestructiveComposeCommand(["down", "-v", "--remove-orphans"])).toBe(true);
  });

  it("does not flag read-only or additive commands", () => {
    for (const cmd of [["up", "-d"], ["ps"], ["logs", "-f", "api"], ["up", "--build", "-d"]]) {
      expect(isDestructiveComposeCommand(cmd), cmd.join(" ")).toBe(false);
    }
  });
});

describe("foreignCheckoutDirs", () => {
  it("is empty when every container came from this checkout", () => {
    expect(foreignCheckoutDirs([label(HERE), label(HERE)], HERE)).toEqual([]);
  });

  it("is empty when there are no containers at all", () => {
    expect(foreignCheckoutDirs([], HERE)).toEqual([]);
  });

  it("reports the other checkout's directory", () => {
    expect(foreignCheckoutDirs([label(OTHER)], HERE)).toEqual([OTHER]);
  });

  it("de-duplicates across containers and compose files", () => {
    expect(foreignCheckoutDirs([label(OTHER), label(OTHER), label(OTHER)], HERE)).toEqual([OTHER]);
  });

  it("reports several foreign checkouts, sorted", () => {
    const third = "/tmp/aaa-clone";
    expect(foreignCheckoutDirs([label(OTHER), label(third)], HERE)).toEqual([third, OTHER]);
  });

  it("normalizes paths before comparing (trailing slash, . segments)", () => {
    expect(foreignCheckoutDirs([label(HERE)], `${HERE}/`)).toEqual([]);
    expect(foreignCheckoutDirs([label(`${HERE}/./`)], HERE)).toEqual([]);
  });

  it("ignores blank entries in the label", () => {
    expect(foreignCheckoutDirs([`${HERE}/docker-compose.simple.yml, ,`], HERE)).toEqual([]);
  });
});

describe("assertProjectOwnedByThisCheckout", () => {
  const capture = (stdout: string) => vi.fn(async () => stdout);

  it("allows a destructive command when this checkout owns the containers", async () => {
    await expect(
      assertProjectOwnedByThisCheckout({
        command: ["down", "-v"],
        root: HERE,
        capture: capture(`${label(HERE)}\n${label(HERE)}\n`),
      }),
    ).resolves.toBeUndefined();
  });

  it("REFUSES down -v when the containers belong to another checkout", async () => {
    // The incident, in one assertion.
    await expect(
      assertProjectOwnedByThisCheckout({
        command: ["down", "-v", "--remove-orphans"],
        root: OTHER,
        capture: capture(`${label(HERE)}\n`),
      }),
    ).rejects.toThrow(/Refusing to run/);
  });

  it("names both directories and the env-var escape hatch in the message", async () => {
    const err = await assertProjectOwnedByThisCheckout({
      command: ["down"],
      root: OTHER,
      capture: capture(`${label(HERE)}\n`),
    }).catch((e: unknown) => e as Error);

    expect(err.message).toContain(HERE);
    expect(err.message).toContain(OTHER);
    expect(err.message).toContain("COMPOSE_PROJECT_NAME");
    // The stakes must be explicit — this is the sentence that stops the mistake.
    expect(err.message).toMatch(/Postgres data/);
  });

  it("never blocks a non-destructive command, even from a foreign checkout", async () => {
    const cap = capture(`${label(HERE)}\n`);
    await expect(
      assertProjectOwnedByThisCheckout({ command: ["up", "-d"], root: OTHER, capture: cap }),
    ).resolves.toBeUndefined();
    // Not even queried: `up` on a shared project is legitimate.
    expect(cap).not.toHaveBeenCalled();
  });

  const failing = () =>
    vi.fn(async () => {
      throw new Error("Cannot connect to the Docker daemon");
    });

  it("FAILS CLOSED on a query error when volumes are at stake", async () => {
    // The first version of this guard failed open on any error. A broken docker
    // template then made it a silent no-op and a volume was destroyed — so an
    // unverifiable `-v` must refuse, not proceed.
    await expect(
      assertProjectOwnedByThisCheckout({
        command: ["down", "-v"],
        root: OTHER,
        capture: failing(),
      }),
    ).rejects.toThrow(/could not determine which checkout owns/);
  });

  it("fails open on a query error for a plain down (containers are recreatable)", async () => {
    await expect(
      assertProjectOwnedByThisCheckout({
        command: ["down"],
        root: OTHER,
        capture: failing(),
      }),
    ).resolves.toBeUndefined();
  });

  it("uses the docker-ps label ACCESSOR, not map indexing", () => {
    // `docker ps` renders .Labels as a string; `{{index .Labels "k"}}` is a
    // template error that exits non-zero. Pin the working form.
    expect(CONFIG_FILES_FORMAT).toBe('{{.Label "com.docker.compose.project.config_files"}}');
    expect(CONFIG_FILES_FORMAT).not.toContain("index .Labels");
  });

  it("classifies volume-destroying commands", () => {
    expect(removesVolumes(["down", "-v"])).toBe(true);
    expect(removesVolumes(["down", "--volumes"])).toBe(true);
    expect(removesVolumes(["down"])).toBe(false);
    expect(removesVolumes(["down", "--remove-orphans"])).toBe(false);
  });

  it("does not block when the project has no containers yet", async () => {
    await expect(
      assertProjectOwnedByThisCheckout({ command: ["down", "-v"], root: HERE, capture: capture("") }),
    ).resolves.toBeUndefined();
  });

  it("queries the project the env var selects, so an override is isolated", async () => {
    const cap = capture("");
    await assertProjectOwnedByThisCheckout({
      command: ["down"],
      root: HERE,
      capture: cap,
      env: { COMPOSE_PROJECT_NAME: "modelgov-scratch" },
    });
    const args = cap.mock.calls[0]![1] as string[];
    expect(args.join(" ")).toContain("com.docker.compose.project=modelgov-scratch");
  });
});

describe("prod is a separate compose project", () => {
  it("targets modelgov-prod for the prod mode", () => {
    expect(composeProjectName({}, "prod")).toBe(PROD_COMPOSE_PROJECT);
    expect(PROD_COMPOSE_PROJECT).toBe("modelgov-prod");
  });

  it("targets modelgov for every local mode", () => {
    for (const m of ["simple", "full", "local", "cloud", "azure", undefined]) {
      expect(composeProjectName({}, m)).toBe(DEFAULT_COMPOSE_PROJECT);
    }
  });

  it("an explicit COMPOSE_PROJECT_NAME still wins for prod", () => {
    expect(composeProjectName({ COMPOSE_PROJECT_NAME: "mine" }, "prod")).toBe("mine");
  });

  it("queries the prod project when tearing prod down", async () => {
    const cap = vi.fn(async () => "");
    await assertProjectOwnedByThisCheckout({
      command: ["down", "-v"], root: "/x", capture: cap, mode: "prod", env: {},
    });
    expect((cap.mock.calls[0]![1] as string[]).join(" ")).toContain(
      "com.docker.compose.project=modelgov-prod",
    );
  });
});
