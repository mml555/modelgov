#!/usr/bin/env node
import { runDoctorProduction } from "./doctorProduction.js";
import { runExplain, type ExplainFlags } from "./explain.js";
import { runKeysCommand } from "./keys.js";
import { runOps, type OpsCommand } from "./ops.js";
import { runRequestsCommand, runUsageSummaryCommand } from "./operator.js";
import { runPolicyTestFile } from "./testPolicy.js";
import { formatValidateResult, validateConfig } from "./validate.js";

const ROOT_USAGE = `modelgov — Modelgov policy and ops tools

Commands:
  setup         First-run setup, stack start, readiness wait, and smoke test
  up            Start a compose stack
  down          Stop a compose stack
  status        Show containers plus /health and /ready
  logs          Follow API logs
  doctor        Check local prerequisites and runtime health
  doctor production  Production env posture (pass/fail + fixes)
  smoke         Run an authenticated chat smoke test
  reset         Stop and remove local compose volumes
  explain       Dry-run a policy decision
  validate      Validate modelgov.yaml
  test-policy   Run policy regression tests from a YAML file
  requests      List or show request audit records
  usage         Usage summaries from audit logs
  keys          Manage DB-backed API keys (create, list, rotate, revoke)

Run 'modelgov <command> --help' for command options.
`;

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    console.log(ROOT_USAGE);
    return;
  }

  const [command, ...rest] = args;
  try {
    switch (command) {
      case "doctor":
        if (rest[0] === "production") {
          const code = runDoctorProduction({
            envFile: flagValue(rest, "--env-file") ?? ".env.production",
            strict: rest.includes("--strict"),
          });
          process.exit(code);
        }
        void runOpsCommand(command, rest);
        break;
      case "setup":
      case "up":
      case "down":
      case "status":
      case "logs":
      case "smoke":
      case "reset":
        void runOpsCommand(command, rest);
        break;
      case "explain":
        void runExplainCommand(rest);
        break;
      case "validate":
        runValidateCommand(rest);
        break;
      case "test-policy":
        runTestPolicyCommand(rest);
        break;
      case "requests":
        void runRequestsCommand(rest).catch((err) => {
          console.error(err instanceof Error ? err.message : err);
          process.exit(1);
        });
        break;
      case "usage":
        void runUsageCommand(rest);
        break;
      case "keys":
        void runKeysCommand(rest).catch((err) => {
          console.error(err instanceof Error ? err.message : err);
          process.exit(1);
        });
        break;
      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(ROOT_USAGE);
        process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

async function runOpsCommand(command: OpsCommand, args: string[]): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(OPS_USAGE);
    return;
  }
  await runOps(command, args).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

function runExplainCommand(args: string[]): void {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(EXPLAIN_USAGE);
    return;
  }
  void runExplain(parseExplainFlags(args)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

function runValidateCommand(args: string[]): void {
  const configPath = flagValue(args, "--config") ?? "./modelgov.yaml";
  const production = args.includes("--production");
  const result = validateConfig({ configPath, production });
  console.log(formatValidateResult(result));
  if (!result.ok) process.exit(1);
}

function runTestPolicyCommand(args: string[]): void {
  const file = flagValue(args, "--file") ?? "./modelgov.policy-tests.yaml";
  const config = flagValue(args, "--config");
  const { results, ok } = runPolicyTestFile(file, config);
  for (const r of results) {
    console.log(r.passed ? `✓ ${r.name}` : `✗ ${r.name}: ${r.message}`);
  }
  if (!ok) process.exit(1);
  console.log(`\n${results.length} passed`);
}

async function runUsageCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "summary") {
    await runUsageSummaryCommand(args.slice(1));
    return;
  }
  if (!sub || sub === "-h" || sub === "--help") {
    console.log(`modelgov usage\n\n  usage summary [options]\n\nRun 'modelgov usage summary --help' for filters.`);
    return;
  }
  throw new Error(`Unknown usage subcommand: ${sub}`);
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const EXPLAIN_USAGE = `modelgov explain [options]

Options:
  --userId <id>           User id (default: explain-user)
  --userType <type>       User type (required)
  --feature <name>        Feature (required)
  --modelClass <class>    Model class (optional)
  --config <path>         modelgov.yaml (default: ./modelgov.yaml)
  --local                 Offline evaluation (no API)
  --baseUrl <url>         API URL (default: http://localhost:3000)
  --apiKey <key>          API key (default: $MODELGOV_API_KEY)
  --json                  JSON output
`;

const OPS_USAGE = `modelgov ops commands

Usage:
  modelgov setup [simple|full|local]
  modelgov up [simple|full|local|prod]
  modelgov down [simple|full|local|prod]
  modelgov status [simple|full|local|prod]
  modelgov logs [simple|full|local|prod] [--no-follow]
  modelgov doctor [simple|full|local|prod]
  modelgov smoke [simple|full|local|prod]
  modelgov reset [simple|full|local|prod] --yes
`;

function parseExplainFlags(args: string[]): ExplainFlags {
  const flags: ExplainFlags = {
    userId: "explain-user",
    configPath: "./modelgov.yaml",
    local: false,
    baseUrl: process.env.MODELGOV_URL ?? "http://localhost:3000",
    apiKey: process.env.MODELGOV_API_KEY,
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--userId":
        flags.userId = requireValue(arg, next);
        i++;
        break;
      case "--userType":
        flags.userType = requireValue(arg, next);
        i++;
        break;
      case "--feature":
        flags.feature = requireValue(arg, next);
        i++;
        break;
      case "--modelClass":
        flags.modelClass = requireValue(arg, next);
        i++;
        break;
      case "--inputTokensEstimate":
        flags.inputTokensEstimate = Number(requireValue(arg, next));
        i++;
        break;
      case "--config":
        flags.configPath = requireValue(arg, next);
        i++;
        break;
      case "--baseUrl":
        flags.baseUrl = requireValue(arg, next);
        i++;
        break;
      case "--apiKey":
        flags.apiKey = requireValue(arg, next);
        i++;
        break;
      case "--local":
        flags.local = true;
        break;
      case "--json":
        flags.json = true;
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (!flags.userType) throw new Error("--userType is required");
  if (!flags.feature) throw new Error("--feature is required");
  return flags;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

main();
