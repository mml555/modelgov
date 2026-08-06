import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The CLI's command routing. It sat behind a blanket `**/index.ts` coverage
// exclusion — 216 lines of dispatch, invisible to the ratchet — because the
// module ended in a bare top-level `main()` call and so could not be imported.

const mods = vi.hoisted(() => ({
  runDoctorProduction: vi.fn(async () => undefined),
  runExplain: vi.fn(async () => undefined),
  runKeysCommand: vi.fn(async () => undefined),
  runOps: vi.fn(async () => undefined),
  runRequestsCommand: vi.fn(async () => undefined),
  runUsageSummaryCommand: vi.fn(async () => undefined),
  runPolicyTestFile: vi.fn(() => undefined),
  validateConfig: vi.fn(() => ({ ok: true })),
  formatValidateResult: vi.fn(() => "ok"),
}));

vi.mock("../src/doctorProduction.js", () => ({ runDoctorProduction: mods.runDoctorProduction }));
vi.mock("../src/explain.js", () => ({ runExplain: mods.runExplain }));
vi.mock("../src/keys.js", () => ({ runKeysCommand: mods.runKeysCommand }));
vi.mock("../src/ops.js", () => ({ runOps: mods.runOps }));
vi.mock("../src/operator.js", () => ({
  runRequestsCommand: mods.runRequestsCommand,
  runUsageSummaryCommand: mods.runUsageSummaryCommand,
}));
vi.mock("../src/testPolicy.js", () => ({ runPolicyTestFile: mods.runPolicyTestFile }));
vi.mock("../src/validate.js", () => ({
  validateConfig: mods.validateConfig,
  formatValidateResult: mods.formatValidateResult,
}));

const { dispatch, main } = await import("../src/index");

let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  err = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("dispatch — routing", () => {
  it.each([
    ["setup"],
    ["up"],
    ["down"],
    ["status"],
    ["logs"],
    ["smoke"],
    ["reset"],
    ["reload-providers"],
  ])("routes '%s' to the ops runner", async (command) => {
    await dispatch(command, []);
    expect(mods.runOps).toHaveBeenCalledOnce();
    expect(mods.runOps.mock.calls[0]?.[0]).toBe(command);
  });

  it("routes the remaining commands to their own runners", async () => {
    await dispatch("explain", ["--userType", "x", "--feature", "y"]);
    expect(mods.runExplain).toHaveBeenCalledOnce();

    await dispatch("requests", []);
    expect(mods.runRequestsCommand).toHaveBeenCalledOnce();

    // `usage` with no subcommand prints its own help; `usage summary` routes.
    await dispatch("usage", ["summary"]);
    expect(mods.runUsageSummaryCommand).toHaveBeenCalledOnce();

    await dispatch("keys", []);
    expect(mods.runKeysCommand).toHaveBeenCalledOnce();
  });

  it("reports an unknown command with the usage text and exit code 1", async () => {
    // Silent success on a typo'd command is the worst outcome for a CLI.
    const code = await dispatch("depoly", []);
    expect(code).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/Unknown command: depoly/);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/Commands:/);
  });
});

describe("dispatch — doctor production", () => {
  it("routes 'doctor production' to the production doctor, not the ops runner", async () => {
    await dispatch("doctor", ["production"]);
    expect(mods.runDoctorProduction).toHaveBeenCalledOnce();
    expect(mods.runOps).not.toHaveBeenCalled();
  });

  it("defaults the env file to .env.production", async () => {
    await dispatch("doctor", ["production"]);
    expect(mods.runDoctorProduction.mock.calls[0]?.[0]).toMatchObject({
      envFile: ".env.production",
      strict: false,
    });
  });

  it("honours --env-file and --strict", async () => {
    await dispatch("doctor", ["production", "--env-file", ".env.staging", "--strict"]);
    expect(mods.runDoctorProduction.mock.calls[0]?.[0]).toMatchObject({
      envFile: ".env.staging",
      strict: true,
    });
  });

  it("sends a bare 'doctor' to the ops runner instead", async () => {
    await dispatch("doctor", []);
    expect(mods.runOps).toHaveBeenCalledOnce();
    expect(mods.runDoctorProduction).not.toHaveBeenCalled();
  });

  it("propagates the doctor's exit code so failed checks fail the shell", async () => {
    mods.runDoctorProduction.mockResolvedValueOnce(2 as never);
    expect(await dispatch("doctor", ["production"])).toBe(2);
  });
});

describe("main", () => {
  const withArgv = (args: string[], fn: () => void) => {
    const argv = process.argv;
    process.argv = ["node", "modelgov", ...args];
    try {
      fn();
    } finally {
      process.argv = argv;
    }
  };

  it("prints usage for no args, -h and --help", () => {
    for (const args of [[], ["-h"], ["--help"]]) {
      log.mockClear();
      withArgv(args, () => main());
      expect(String(log.mock.calls[0]?.[0])).toMatch(/modelgov — Modelgov policy and ops tools/);
    }
  });

  it("strips a leading '--' so `pnpm dev -- validate` works", () => {
    // pnpm inserts the separator; treating it as the command would print usage.
    withArgv(["--", "status"], () => main());
    expect(mods.runOps).toHaveBeenCalledOnce();
    expect(mods.runOps.mock.calls[0]?.[0]).toBe("status");
  });
});
