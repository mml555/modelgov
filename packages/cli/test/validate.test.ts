import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  it("flags a missing non-api_key provider env ref (e.g. Azure api_base)", () => {
    const dir = mkdtempSync(join(tmpdir(), "modelgov-validate-"));
    const path = join(dir, "modelgov.yaml");
    writeFileSync(
      path,
      [
        "project: { name: t, environment: production }",
        "providers:",
        "  azure:",
        "    api_key: env/AZURE_API_KEY",
        "    api_base: env/AZURE_API_BASE",
        "budgets:",
        "  global: { monthly_usd: 100, alert_at_percent: 80, hard_stop_at_percent: 100 }",
        "  by_user_type: { logged_in: { daily_usd: 1, daily_requests: 10, models: [cheap] } }",
        "features: { chat: { safety: balanced, model_class: cheap, max_tokens: 500 } }",
        "model_classes: { cheap: { primary: azure/gpt-4o-mini } }",
        "safety: { preset: balanced, injection_model: azure/gpt-4o-mini }",
        "",
      ].join("\n"),
    );
    // Only the api_key is set; the api_base env ref is missing → flagged.
    const result = validateConfig({ configPath: path, production: true, env: { AZURE_API_KEY: "x" } });
    const missing = result.issues.filter((i) => i.code === "missing_provider_key");
    expect(missing.some((i) => i.message.includes("AZURE_API_BASE"))).toBe(true);
    expect(missing.some((i) => i.message.includes("AZURE_API_KEY"))).toBe(false);
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
