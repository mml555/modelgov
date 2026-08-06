/**
 * Refuse to run destructive test setup against anything that might be a real
 * database.
 *
 * `setup.ts` TRUNCATEs every table in `public` before each test file, and it
 * does so against whatever `DATABASE_URL` happens to hold. One stale export in
 * a shell — a dev database, a staging box — and running `pnpm test` destroys
 * it, with no prompt and no undo.
 *
 * The repo's own tooling makes the safe cases identifiable: `test-with-db.sh`
 * uses `localhost:55433` (overridable via `AIGUARD_TEST_PG_PORT`) and CI uses
 * `localhost:55432`. Both are loopback on a deliberately non-default port, and
 * that is the signal this guard keys on — the database NAME is `modelgov` in
 * both, so it cannot distinguish them from a real one.
 */

/** Postgres's default port. A database here is almost never a throwaway. */
const DEFAULT_PG_PORT = "5432";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

/** Opt-in escape hatch for a deliberately unusual local setup. */
const OVERRIDE_ENV = "MODELGOV_ALLOW_DESTRUCTIVE_TEST_DB";

export class UnsafeTestDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeTestDatabaseError";
  }
}

/**
 * Throws unless `url` looks like a disposable test database.
 *
 * Deliberately conservative: it is far better to make someone set one env var
 * than to silently wipe a database that mattered.
 */
export function assertTestDatabase(url: string): void {
  if (process.env[OVERRIDE_ENV] === "1") return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Unparseable: fail closed. We cannot show it is safe, so we do not proceed.
    throw new UnsafeTestDatabaseError(
      `DATABASE_URL is not a valid URL, so it cannot be verified as a test database.\n` +
        `Refusing to truncate. Set ${OVERRIDE_ENV}=1 to override.`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || DEFAULT_PG_PORT;
  const reasons: string[] = [];
  if (!LOOPBACK.has(host)) reasons.push(`host "${parsed.hostname}" is not loopback`);
  if (port === DEFAULT_PG_PORT) reasons.push(`port ${port} is the default Postgres port`);

  if (reasons.length > 0) {
    throw new UnsafeTestDatabaseError(
      `Refusing to run destructive test setup against ${host}:${port} — ${reasons.join(" and ")}.\n` +
        `The test suite TRUNCATEs every table in the 'public' schema, which would destroy this database.\n\n` +
        `Use the repo's disposable Postgres instead:\n` +
        `  pnpm test            # starts a throwaway container\n` +
        `  AIGUARD_TEST_PG_PORT=55437 pnpm test   # if 55433 is taken\n\n` +
        `If this really is a throwaway database, set ${OVERRIDE_ENV}=1.`,
    );
  }
}
