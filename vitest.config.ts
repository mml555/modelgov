import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromHere = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Resolve workspace packages to their TS source so unit tests run
      // without a prior build step.
      "@modelgov/policy-engine": fromHere("./packages/policy-engine/src/index.ts"),
      "@modelgov/sdk": fromHere("./packages/sdk-typescript/src/index.ts"),
    },
  },
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "examples/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.ts",
    ],
    environment: "node",
    // Integration tests share one Postgres and TRUNCATE between cases; running
    // test files in parallel would let them stomp on each other's rows.
    fileParallelism: false,
    // Apply the schema once for the whole run (not per file — see globalSetup),
    // and give every file a clean-slate DB before it runs (setup.ts), so state
    // can't bleed across files under the sequencer's run-to-run reordering. Both
    // no-op without DATABASE_URL (unit-only runs).
    globalSetup: ["packages/api/test/globalSetup.ts"],
    setupFiles: ["packages/api/test/setup.ts"],
    // migration-upgrade.test.ts migrates a throwaway DB inside the test (~seconds);
    // 30s matches the DB statement_timeout so a slow-but-completing op on the
    // shared Docker Postgres isn't killed by vitest's tight 5s/10s defaults.
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
        "packages/cli/src/**/*.ts",
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
      //
      // 2026-07-03 re-baseline (two changes at once, both documented so the
      // lower absolute numbers aren't mistaken for a coverage regression):
      //  1. The CLI joined the measured surface (previously invisible to the
      //     ratchet) at a much lower starting point.
      //  2. vitest 2 → 4: the v8 provider's AST-aware remapping counts
      //     statements/branches differently, shifting every package's numbers
      //     down several points for the same tests.
      // The per-package globs pin each package at its own measured level, so
      // the global gate can't hide a regression in one package behind gains in
      // another. (Vitest counts glob-matched files in the global gate too.)
      thresholds: {
        lines: 75,
        functions: 78,
        branches: 65,
        statements: 73,
        "packages/api/src/**/*.ts": {
          lines: 83,
          functions: 85,
          branches: 70,
          statements: 80,
        },
        "packages/policy-engine/src/**/*.ts": {
          lines: 95,
          functions: 98,
          branches: 91,
          statements: 94,
        },
        "packages/sdk-typescript/src/**/*.ts": {
          lines: 82,
          functions: 67,
          branches: 73,
          statements: 79,
        },
        "packages/cli/src/**/*.ts": {
          lines: 25,
          functions: 27,
          branches: 21,
          statements: 24,
        },
      },
    },
  },
});
