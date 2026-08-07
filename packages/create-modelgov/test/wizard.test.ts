import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The wizard entrypoint. It was invisible to the coverage ratchet behind a
// blanket `**/index.ts` exclusion — while THIS package is deliberately measured
// because "a regression here misconfigures every new install". These tests are
// what make un-excluding it honest.

// `group` INVOKES each step thunk, exactly as @clack/prompts does, then
// substitutes the test's chosen answer. Returning canned answers without
// running the thunks would leave every `() => text({...})` uncovered — and
// would not notice a prompt built with broken options, which is most of what
// can actually regress in this file.
const prompts = vi.hoisted(() => {
  const answers: Record<string, unknown> = {};
  return {
    answers,
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    cancel: vi.fn(),
    confirm: vi.fn(),
    isCancel: vi.fn(() => false),
    text: vi.fn((o: unknown) => o),
    select: vi.fn((o: unknown) => o),
    multiselect: vi.fn((o: unknown) => o),
    group: vi.fn(async (steps: Record<string, (c: unknown) => unknown>) => {
      const results: Record<string, unknown> = {};
      for (const [key, step] of Object.entries(steps)) {
        await step({ results });
        results[key] = answers[key];
      }
      return results;
    }),
  };
});
vi.mock("@clack/prompts", () => prompts);

/** Set the answers the mocked wizard will return. */
function answerWith(a: Record<string, unknown>): void {
  for (const k of Object.keys(prompts.answers)) delete prompts.answers[k];
  Object.assign(prompts.answers, a);
}

const WIZARD_ANSWERS = {
  projectName: "acme",
  framework: "nextjs",
  template: "support_chat",
  providers: ["anthropic"],
  safety: "strict",
  mode: "full",
};

const { main, parseFlags, promptOptions, resolveNonInteractive, validateFlags } = await import("../src/wizard");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "create-modelgov-"));
  vi.clearAllMocks();
  prompts.isCancel.mockReturnValue(false);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseFlags", () => {
  it("reads every documented flag", () => {
    expect(
      parseFlags([
        "--name", "acme",
        "--framework", "nextjs",
        "--template", "support_chat",
        "--provider", "openai,anthropic",
        "--safety", "strict",
        "--mode", "full",
        "--yes",
        "./out",
      ]),
    ).toEqual({
      name: "acme",
      framework: "nextjs",
      template: "support_chat",
      providers: ["openai", "anthropic"],
      safety: "strict",
      mode: "full",
      yes: true,
      dir: "./out",
    });
  });

  it("accepts -y and the --providers alias", () => {
    expect(parseFlags(["-y", "--providers", "openai"])).toEqual({
      yes: true,
      providers: ["openai"],
    });
  });

  it("trims and drops empty entries in a provider list", () => {
    // `--provider "openai, ,anthropic,"` is what a shell loop produces.
    expect(parseFlags(["--provider", "openai, ,anthropic,"]).providers).toEqual([
      "openai",
      "anthropic",
    ]);
  });

  it("yields no providers for an empty list rather than [\"\"]", () => {
    // [""] would scaffold a provider block named "" — worse than none.
    expect(parseFlags(["--provider", ""]).providers).toEqual([]);
  });

  it("takes the last positional as the target directory", () => {
    expect(parseFlags(["--name", "a", "out"]).dir).toBe("out");
  });

  it("rejects a flag whose value is missing rather than eating the next flag", () => {
    // `--name --yes` would otherwise set name to "--yes" AND silently drop
    // --yes, scaffolding a project with a nonsense name.
    for (const argv of [
      ["--name", "--yes"],
      ["--template"],
      ["--framework", "--mode", "full"],
      ["--provider"],
    ]) {
      expect(() => parseFlags(argv), argv.join(" ")).toThrow(/requires a value/);
    }
  });

  it("returns an empty object for no arguments", () => {
    expect(parseFlags([])).toEqual({});
  });
});

describe("resolveNonInteractive", () => {
  it("validates supplied flags even with no template, before falling through", () => {
    // The early return used to skip validation entirely, so `--framework next`
    // with no --template reached the wizard and crashed later in the scaffolder.
    expect(() => resolveNonInteractive({ framework: "next" as never })).toThrow(
      /unknown framework 'next'/,
    );
    expect(() => resolveNonInteractive({ safety: "bogus" as never })).toThrow(
      /unknown safety preset/,
    );
    expect(() => validateFlags({ mode: "compose" as never })).toThrow(/unknown mode/);
  });

  it("returns null without a template, so the wizard prompts", () => {
    expect(resolveNonInteractive({ name: "acme" })).toBeNull();
  });

  it("throws on an unknown template and lists the valid ones", () => {
    // A silent fallback here would scaffold the wrong project in CI.
    expect(() => resolveNonInteractive({ template: "nope" as never })).toThrow(
      /unknown template 'nope'.*support_chat/s,
    );
  });

  it("fills defaults for everything the flags omit", () => {
    const opts = resolveNonInteractive({ template: "support_chat" });
    expect(opts).toMatchObject({
      projectName: "my-app",
      framework: "none",
      providers: ["openai"],
      safetyPreset: "balanced",
      mode: "simple",
    });
  });

  it("rejects a typo'd framework instead of crashing deep in the scaffolder", () => {
    // `next` for `nextjs` used to reach adapterFor (no default case) and die
    // with "Cannot read properties of undefined (reading 'files')".
    expect(() => resolveNonInteractive({ template: "support_chat", framework: "next" as never })).toThrow(
      /unknown framework 'next'.*nextjs/s,
    );
  });

  it("rejects an unknown safety preset rather than writing it into the config", () => {
    // This one SUCCEEDED before, emitting `preset: bogus` into modelgov.yaml —
    // a scaffold that looks fine and fails at gateway boot.
    expect(() => resolveNonInteractive({ template: "support_chat", safety: "bogus" as never })).toThrow(
      /unknown safety preset 'bogus'.*balanced/s,
    );
  });

  it("rejects an unknown deploy mode", () => {
    expect(() => resolveNonInteractive({ template: "support_chat", mode: "compose" as never })).toThrow(
      /unknown mode 'compose'.*simple, full/s,
    );
  });

  it("rejects an unknown provider", () => {
    expect(() =>
      resolveNonInteractive({ template: "support_chat", providers: ["opnai" as never] }),
    ).toThrow(/unknown provider 'opnai'.*openai/s);
  });

  it("accepts every documented value for each validated flag", () => {
    // Guards against the validator drifting from the types it mirrors.
    for (const framework of ["nextjs", "express", "fastify", "fastapi", "none"] as const) {
      expect(() => resolveNonInteractive({ template: "support_chat", framework })).not.toThrow();
    }
    for (const safety of ["dev", "balanced", "strict"] as const) {
      expect(() => resolveNonInteractive({ template: "support_chat", safety })).not.toThrow();
    }
    for (const mode of ["simple", "full"] as const) {
      expect(() => resolveNonInteractive({ template: "support_chat", mode })).not.toThrow();
    }
  });

  it("forces an empty provider list for a local-only template", () => {
    // Requesting openai for a local template would write a key block the
    // template cannot use.
    const opts = resolveNonInteractive({ template: "local_dev", providers: ["openai"] });
    expect(opts?.providers).toEqual([]);
  });

  it("honours explicit flags over the defaults", () => {
    expect(
      resolveNonInteractive({
        template: "support_chat",
        name: "acme",
        framework: "nextjs",
        providers: ["anthropic"],
        safety: "strict",
        mode: "full",
      }),
    ).toMatchObject({
      projectName: "acme",
      framework: "nextjs",
      providers: ["anthropic"],
      safetyPreset: "strict",
      mode: "full",
    });
  });
});

/** Run main() with argv pointed at the temp dir. */
async function runMain(args: string[]): Promise<void> {
  const argv = process.argv;
  process.argv = ["node", "create-modelgov", ...args, dir];
  try {
    await main();
  } finally {
    process.argv = argv;
  }
}

describe("main — non-interactive scaffold", () => {
  it("writes the template's files into the target directory", async () => {
    await runMain(["--template", "local_dev", "--yes"]);
    expect(existsSync(join(dir, "modelgov.yaml"))).toBe(true);
    expect(existsSync(join(dir, "docker-compose.yml"))).toBe(true);
    // Never prompted — this path must stay usable from CI.
    expect(prompts.group).not.toHaveBeenCalled();
  });

  it("creates nested directories rather than failing on a missing parent", async () => {
    await runMain(["--template", "local_dev", "--yes"]);
    expect(existsSync(join(dir, "scripts"))).toBe(true);
  });

  it("reports what it wrote", async () => {
    await runMain(["--template", "local_dev", "--yes"]);
    expect(String(prompts.note.mock.calls[0]?.[0])).toMatch(/Scaffolded \d+ files/);
    expect(prompts.outro).toHaveBeenCalled();
  });
});

describe("main — interactive path", () => {
  it("falls through to the wizard when no template flag is given", async () => {
    // resolveNonInteractive returns null here, so main must prompt. Nothing
    // else exercises that branch of main.
    answerWith({ ...WIZARD_ANSWERS, template: "local_dev", providers: [] });
    await runMain(["--yes"]);
    expect(prompts.group).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, "modelgov.yaml"))).toBe(true);
  });

  it("seeds the prompts with the flags already supplied", async () => {
    // A half-specified invocation should not make the user retype what they
    // already passed.
    answerWith({ ...WIZARD_ANSWERS, template: "local_dev", providers: [] });
    await promptOptions({ name: "from-flag", template: "support_chat", providers: ["openai"] });
    expect(prompts.text.mock.calls[0]?.[0]).toMatchObject({ defaultValue: "from-flag" });
    expect(
      prompts.select.mock.calls.some((c) => (c[0] as { initialValue?: string })?.initialValue === "support_chat"),
    ).toBe(true);
    expect(
      prompts.multiselect.mock.calls.some((c) =>
        Array.isArray((c[0] as { initialValues?: string[] })?.initialValues),
      ),
    ).toBe(true);
  });
});

describe("main — the overwrite guard", () => {
  it("asks before clobbering existing files", async () => {
    writeFileSync(join(dir, "modelgov.yaml"), "KEEP ME");
    prompts.confirm.mockResolvedValue(true);
    await runMain(["--template", "local_dev"]);
    expect(prompts.confirm).toHaveBeenCalledOnce();
    expect(String(prompts.confirm.mock.calls[0]?.[0]?.message)).toMatch(/Overwrite 1 existing file/);
    expect(readFileSync(join(dir, "modelgov.yaml"), "utf8")).not.toBe("KEEP ME");
  });

  it("leaves files untouched when the user declines", async () => {
    writeFileSync(join(dir, "modelgov.yaml"), "KEEP ME");
    prompts.confirm.mockResolvedValue(false);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as never);
    await expect(runMain(["--template", "local_dev"])).rejects.toThrow("exited");
    expect(readFileSync(join(dir, "modelgov.yaml"), "utf8")).toBe("KEEP ME");
    expect(prompts.cancel).toHaveBeenCalled();
    exit.mockRestore();
  });

  it("treats a cancelled prompt as a decline, not a yes", async () => {
    // isCancel() true with a falsy value must not read as consent to overwrite.
    writeFileSync(join(dir, "modelgov.yaml"), "KEEP ME");
    prompts.confirm.mockResolvedValue(undefined);
    prompts.isCancel.mockReturnValue(true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as never);
    await expect(runMain(["--template", "local_dev"])).rejects.toThrow("exited");
    expect(readFileSync(join(dir, "modelgov.yaml"), "utf8")).toBe("KEEP ME");
    exit.mockRestore();
  });

  it("skips the prompt entirely with --yes", async () => {
    writeFileSync(join(dir, "modelgov.yaml"), "OLD");
    await runMain(["--template", "local_dev", "--yes"]);
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "modelgov.yaml"), "utf8")).not.toBe("OLD");
  });
});

describe("promptOptions", () => {
  it("maps the wizard's answers onto the scaffold options", async () => {
    answerWith(WIZARD_ANSWERS);
    const opts = await promptOptions({});
    expect(opts).toMatchObject({
      projectName: "acme",
      framework: "nextjs",
      providers: ["anthropic"],
      safetyPreset: "strict",
      mode: "full",
    });
    expect(opts.template.id).toBe("support_chat");
    expect(prompts.intro).toHaveBeenCalled();
  });

  it("drops providers for a local-only template chosen interactively", async () => {
    // Same rule as the flag path; the two must not disagree.
    answerWith({ ...WIZARD_ANSWERS, template: "local_dev", providers: ["openai"] });
    expect((await promptOptions({})).providers).toEqual([]);
  });
});
