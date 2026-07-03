import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  evaluateAiRequest,
  parseConfig,
  type ModelgovConfig,
  type PolicyReasonCode,
  type UsageSnapshot,
} from "@modelgov/policy-engine";
import { resolveUserPath } from "./paths.js";

export interface PolicyTestCase {
  name: string;
  input: {
    userId?: string;
    userType: string;
    feature: string;
    modelClass?: string;
    inputTokensEstimate?: number;
  };
  usage?: Partial<UsageSnapshot>;
  expect: {
    decision: string;
    reasonCode?: PolicyReasonCode;
    resolvedModelClass?: string;
    wouldCallModel?: boolean;
  };
}

export interface PolicyTestFile {
  config?: string;
  cases: PolicyTestCase[];
}

export interface PolicyTestResult {
  name: string;
  passed: boolean;
  message?: string;
}

const ZERO_USAGE: UsageSnapshot = {
  userDailyUsdUsed: 0,
  userDailyUsdReserved: 0,
  userDailyRequestsUsed: 0,
  featureMonthlyUsdUsed: 0,
  featureMonthlyUsdReserved: 0,
  globalMonthlyUsdUsed: 0,
  globalMonthlyUsdReserved: 0,
};

export function loadPolicyTestFile(path: string): PolicyTestFile {
  const raw = parseYaml(readFileSync(resolveUserPath(path), "utf8")) as PolicyTestFile;
  if (!raw?.cases?.length) {
    throw new Error("policy test file must define at least one case");
  }
  return raw;
}

export function runPolicyTests(
  config: ModelgovConfig,
  cases: PolicyTestCase[],
): PolicyTestResult[] {
  return cases.map((testCase) => runOne(config, testCase));
}

function runOne(config: ModelgovConfig, testCase: PolicyTestCase): PolicyTestResult {
  const usage: UsageSnapshot = { ...ZERO_USAGE, ...testCase.usage };
  try {
    const decision = evaluateAiRequest({
      request: {
        projectId: config.project.name,
        environment: config.project.environment,
        userId: testCase.input.userId ?? "policy-test-user",
        userType: testCase.input.userType,
        feature: testCase.input.feature,
        requestedModelClass: testCase.input.modelClass,
        inputTokensEstimate: testCase.input.inputTokensEstimate,
      },
      config,
      usage,
    });

    const failures: string[] = [];
    if (decision.decision !== testCase.expect.decision) {
      failures.push(`decision: expected ${testCase.expect.decision}, got ${decision.decision}`);
    }
    if (
      testCase.expect.reasonCode &&
      decision.reasonCode !== testCase.expect.reasonCode
    ) {
      failures.push(
        `reasonCode: expected ${testCase.expect.reasonCode}, got ${decision.reasonCode ?? "undefined"}`,
      );
    }
    if (
      testCase.expect.resolvedModelClass &&
      decision.resolvedModelClass !== testCase.expect.resolvedModelClass
    ) {
      failures.push(
        `resolvedModelClass: expected ${testCase.expect.resolvedModelClass}, got ${decision.resolvedModelClass}`,
      );
    }
    if (testCase.expect.wouldCallModel !== undefined) {
      const wouldCall = decision.decision !== "block";
      if (wouldCall !== testCase.expect.wouldCallModel) {
        failures.push(`wouldCallModel: expected ${testCase.expect.wouldCallModel}, got ${wouldCall}`);
      }
    }

    if (failures.length > 0) {
      return { name: testCase.name, passed: false, message: failures.join("; ") };
    }
    return { name: testCase.name, passed: true };
  } catch (err) {
    return {
      name: testCase.name,
      passed: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function runPolicyTestFile(
  testFilePath: string,
  configPath?: string,
): { results: PolicyTestResult[]; ok: boolean } {
  const resolvedTestFilePath = resolveUserPath(testFilePath);
  const file = loadPolicyTestFile(resolvedTestFilePath);
  const configFile = configPath
    ? resolveUserPath(configPath)
    : file.config
      ? resolve(dirname(resolvedTestFilePath), file.config)
      : resolveUserPath("./modelgov.yaml");
  const config = parseConfig(readFileSync(configFile, "utf8"));
  const results = runPolicyTests(config, file.cases);
  return { results, ok: results.every((r) => r.passed) };
}
