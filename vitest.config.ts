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
      // Measure each package's WHOLE source surface, not an allow-list — a gate
      // over hand-picked files reports high numbers while core paths go
      // unmeasured. Only process entry scripts (boot wiring with no unit
      // surface) and un-renderable UI are excluded, explicitly and with a
      // reason, so nothing silently drops out.
      include: [
        "packages/policy-engine/src/**/*.ts",
        "packages/api/src/**/*.ts",
        "packages/sdk-typescript/src/**/*.ts",
        "packages/cli/src/**/*.ts",
        // The wizard's config generator: it writes litellm_config.generated.yaml
        // and modelgov.yaml, so a regression here misconfigures every new install.
        "packages/create-modelgov/src/**/*.ts",
        // Operator-console LOGIC only (see the .tsx note in `exclude`). The console
        // is the primary onboarding path, so its provider catalog, wizard flow,
        // and API wrappers belong under the ratchet.
        "apps/operator-console/src/**/*.ts",
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
        // React components are NOT measured: this suite runs in the `node`
        // environment with no DOM, so no test can render them and including them
        // would dilute the console gate toward zero — a lower number that hides
        // regressions in the logic that IS tested. The console's testable logic
        // lives in plain .ts modules (setup/, api/, *View.ts), which ARE measured.
        // Adding a jsdom environment + component tests is the way to close this;
        // until then the gap is explicit rather than averaged away.
        "apps/operator-console/src/**/*.tsx",
        // Vite type shim, no runtime surface.
        "apps/operator-console/src/vite-env.d.ts",
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
      //
      // 2026-08-04: create-modelgov and the operator-console's .ts logic joined
      // the measured surface (940 → 1056 counted functions), so the GLOBAL
      // numbers are not comparable to earlier runs. Measured global after the
      // change: 79.28 lines / 79.16 functions / 71.22 branches / 77.19
      // statements — every global gate below still clears with headroom, so they
      // are left as-is rather than re-baselined against a moving surface.
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
        // 2026-08-04 ratchet: the CLI + wizard were the least-measured code in the
        // repo while carrying the most user-facing bug traffic (setup/provider-config
        // fixes). Added tests for setupConfig (env parsing, demo-vs-real detection),
        // the ops decision helpers (isRealSecret, rerunCommand), and the production
        // doctor checks; the gate moves 25 → 35 statements to lock that in.
        //
        // The three gates below sit ~2-3 points under their measured values, not
        // the usual ~1: they were baselined on Node 24 while CI runs Node 22, and
        // v8's coverage remapping differs slightly between V8 versions. Re-measure
        // on Node 22 before tightening them further.
        // Measured 2026-08-04: 37.29 lines / 38.00 functions / 40.14 branches / 37.85 statements.
        "packages/cli/src/**/*.ts": {
          lines: 35,
          functions: 36,
          branches: 37,
          statements: 35,
        },
        // Newly gated (was measured by nothing). Already well covered by
        // render.test.ts — this pins it so it stays that way.
        // Measured 2026-08-04: 97.66 lines / 96.30 functions / 88.68 branches / 97.06 statements.
        //
        // `functions` is 92, not the ~95 the percentage would suggest: this package
        // has only 27 counted functions, so ONE function is worth 3.7 points. At 94
        // the gate needed 26/27 — a single new uncovered helper would red CI. 92 is
        // the nearest value that leaves one function of real headroom. Judge small
        // packages by absolute slack, not by the percentage margin.
        "packages/create-modelgov/src/**/*.ts": {
          lines: 95,
          functions: 92,
          branches: 86,
          statements: 95,
        },
        // Newly gated. Covers the console's .ts logic only (React components are
        // excluded above); the wizard catalog, persistence, and setup API wrappers
        // were at 0% before this baseline. usePolling.ts is still 0% — a React
        // hook needs a renderer, so it waits on the jsdom work noted above.
        // Measured 2026-08-04: 70.86 lines / 64.04 functions / 77.63 branches / 68.21 statements.
        "apps/operator-console/src/**/*.ts": {
          lines: 68,
          functions: 61,
          branches: 74,
          statements: 65,
        },
      },
    },
  },
});
