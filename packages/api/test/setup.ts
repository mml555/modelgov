import { beforeAll } from "vitest";
import { createPool } from "../src/db/pool";

/**
 * Give every test FILE a clean database before it runs. This hook is registered
 * from a setup file, so it fires once per file BEFORE that file's own
 * `beforeAll` — the file then seeds onto a guaranteed-clean slate.
 *
 * Integration files share one Postgres and used to each reset only the subset of
 * tables they knew about, so rows could bleed across files (e.g. a leftover
 * emergency pause in `system_flags` making later chat files 503, or config rows
 * a policy file left behind). Because the sequencer reorders files run-to-run,
 * that bleed surfaced non-deterministically. Truncating every table here removes
 * cross-file bleed at the root — no per-file truncation list to drift.
 *
 * The table list is discovered from the catalog (not hard-coded) so a new
 * migration's table is covered automatically. `schema_migrations` is excluded:
 * globalSetup applied the schema and this must not undo that record. No-op when
 * DATABASE_URL is unset (unit test files).
 */
beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const pool = createPool(url);
  try {
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
    );
    if (rows.length > 0) {
      const list = rows.map((r) => `"${r.tablename}"`).join(", ");
      await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await pool.end();
  }
});
