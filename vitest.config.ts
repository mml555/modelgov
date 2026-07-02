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
      // Measure the WHOLE api + policy-engine surface, not an allow-list — a
      // gate over hand-picked files reports high numbers while core paths go
      // unmeasured. Only process entry scripts (boot wiring with no unit
      // surface) are excluded, explicitly, so nothing silently drops out.
      include: [
        "packages/policy-engine/src/**/*.ts",
        "packages/api/src/**/*.ts",
        "packages/sdk-typescript/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/index.ts",
        "packages/api/src/migrate.ts",
        "packages/api/src/openapiExport.ts",
        "packages/sdk-typescript/src/generated/**",
        "packages/sdk-typescript/src/types.ts",
        "packages/api/src/modules/**/types.ts",
        "packages/api/src/types.ts",
      ],
      // Set just below measured coverage so a regression fails CI while leaving
      // headroom for legitimate refactors. Ratchet these UP as gaps close;
      // never widen them back down.
      thresholds: {
        lines: 88,
        functions: 90,
        branches: 80,
        statements: 88,
      },
    },
  },
});
