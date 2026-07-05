import { applySchema } from "../src/db/init";
import { createPool } from "../src/db/pool";

/**
 * Apply the schema ONCE for the whole test run, before any test file.
 *
 * Previously every integration file re-ran `applySchema` (all migrations under
 * an advisory lock) in its own `beforeAll`, so whichever file the sequencer
 * happened to run first bore the full cold-migration cost — which, against a
 * shared Docker Postgres under load, intermittently exceeded vitest's hook
 * timeout and skipped that whole file (non-deterministically, since the
 * sequencer reorders files by cached duration run-to-run). A globalSetup runs
 * outside any test's hook-timeout budget, so the one-time cold migration can no
 * longer flake a file. No-op when DATABASE_URL is unset (unit-only runs).
 */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const pool = createPool(url);
  try {
    await applySchema(pool);
  } finally {
    await pool.end();
  }
}
