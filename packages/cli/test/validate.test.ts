import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { validateConfig } from "../src/validate.js";
import { runPolicyTestFile } from "../src/testPolicy.js";

describe("modelgov validate", () => {
  it("accepts production example config when keys are set", () => {
    const result = validateConfig({
      configPath: "modelgov.production.example.yaml",
      production: true,
      env: { OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "x" },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects missing provider keys in production mode", () => {
    const result = validateConfig({
      configPath: "modelgov.yaml",
      production: true,
      env: {},
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "missing_provider_key")).toBe(true);
  });

  it("resolves relative config paths from the original pnpm cwd", () => {
    const root = process.cwd();
    process.chdir(resolve(root, "packages/cli"));
    try {
      const result = validateConfig({
        configPath: "modelgov.production.example.yaml",
        production: true,
        env: {
          INIT_CWD: root,
          OPENAI_API_KEY: "x",
          ANTHROPIC_API_KEY: "x",
        },
      });
      expect(result.ok).toBe(true);
    } finally {
      process.chdir(root);
    }
  });
});

describe("modelgov test-policy", () => {
  it("runs repo policy regression file", () => {
    const { ok, results } = runPolicyTestFile("modelgov.policy-tests.yaml");
    expect(results.length).toBeGreaterThan(0);
    expect(ok).toBe(true);
  });

  it("resolves relative policy-test paths from the original pnpm cwd", () => {
    const root = process.cwd();
    const previousInitCwd = process.env.INIT_CWD;
    process.chdir(resolve(root, "packages/cli"));
    process.env.INIT_CWD = root;
    try {
      const { ok, results } = runPolicyTestFile("modelgov.policy-tests.yaml");
      expect(results.length).toBeGreaterThan(0);
      expect(ok).toBe(true);
    } finally {
      if (previousInitCwd === undefined) {
        delete process.env.INIT_CWD;
      } else {
        process.env.INIT_CWD = previousInitCwd;
      }
      process.chdir(root);
    }
  });
});
