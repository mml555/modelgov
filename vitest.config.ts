import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromHere = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Resolve workspace packages to their TS source so unit tests run
      // without a prior build step.
      "@ai-guard/policy-engine": fromHere("./packages/policy-engine/src/index.ts"),
      "@ai-guard/sdk": fromHere("./packages/sdk-typescript/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts", "examples/**/test/**/*.test.ts"],
    environment: "node",
    // Integration tests share one Postgres and TRUNCATE between cases; running
    // test files in parallel would let them stomp on each other's rows.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: [
        "packages/policy-engine/src/**/*.ts",
        "packages/api/src/modules/usage/repo.ts",
        // Enterprise control-plane modules with dedicated test suites.
        "packages/api/src/modules/keys/**/*.ts",
        "packages/api/src/modules/authz/**/*.ts",
        "packages/api/src/modules/audit/**/*.ts",
        "packages/api/src/modules/governance/**/*.ts",
        "packages/api/src/config/secrets.ts",
      ],
      exclude: ["**/*.test.ts", "**/index.ts"],
      // Set just below measured coverage so a regression fails CI while leaving
      // headroom for legitimate refactors.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 80,
        statements: 90,
      },
    },
  },
});
