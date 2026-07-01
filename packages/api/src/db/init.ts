import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { withAdvisoryLock } from "./advisoryLock";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

// Schema source of truth: packages/api/src/db/migrations/*.sql (not a standalone schema.sql).

// Session-level advisory lock key. Every process that runs applySchema tries to
// take this lock first, so concurrent starters (N API replicas booting at once,
// or a migrate job racing a replica) serialize instead of racing DDL — which
// otherwise deadlocks or throws duplicate-pg_type errors. The lock auto-releases
// if the holder crashes, since it is tied to the session.
const MIGRATION_LOCK_KEY = 918_273_645;

/** Apply the (idempotent) schema to a database. */
export async function applySchema(pool: Pool): Promise<void> {
  await withAdvisoryLock(pool, MIGRATION_LOCK_KEY, () => runMigrations(pool));
}

async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();

  // Fail loudly rather than silently applying zero migrations (leaving an empty
  // schema and confusing runtime 500s). This is the tripwire for a build that
  // copied migrations to the wrong place — e.g. a nested dist/migrations/migrations.
  if (files.length === 0) {
    throw new Error(
      `no migration files found in ${MIGRATIONS_DIR} — the build did not place ` +
        `migrations where the runtime expects them`,
    );
  }

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const applied = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [version],
    );
    if (applied.rowCount) continue;

    const sql = readFileSync(new URL(`./migrations/${file}`, import.meta.url), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [version],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

// NOTE: no CLI self-invocation here. `migrate.ts` is the single schema-apply
// entrypoint. A guarded `main()` here would also fire when this module is
// bundled into migrate.js (its `import.meta.url` matches process.argv[1]),
// causing two concurrent applySchema() calls to race on CREATE TABLE IF NOT
// EXISTS (duplicate pg_type). Keep this module pure.
