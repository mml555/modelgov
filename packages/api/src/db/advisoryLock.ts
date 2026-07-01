import type { Pool } from "pg";

/**
 * Postgres advisory-lock helpers. Advisory locks are cluster-wide mutexes keyed
 * by an integer; we use them so that N API replicas cooperate on
 * "exactly/at-most one does this" work (schema migration, periodic maintenance)
 * without a leader-election dependency.
 *
 * Both helpers take a dedicated connection for the lock so the guarded work can
 * use other pool connections freely, and always release on the way out.
 */

/**
 * Run `fn` while holding a session-level advisory lock, blocking until the lock
 * is free. Use for "exactly one at a time" work (e.g. applying migrations):
 * concurrent callers serialize rather than racing.
 */
export async function withAdvisoryLock<T>(
  pool: Pool,
  key: number,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [key]);
    try {
      return await fn();
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [key])
        .catch(() => {});
    }
  } finally {
    client.release();
  }
}

/**
 * Try to take a non-blocking advisory lock; run `fn` only if it was acquired.
 * Returns true if `fn` ran (this caller held the lock), false if another holder
 * had it (caller should skip). Use for "at most one replica per tick" elections.
 * The lock is released even if `fn` throws (the error propagates).
 */
export async function tryWithAdvisoryLock(
  pool: Pool,
  key: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  const client = await pool.connect();
  let held = false;
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS ok",
      [key],
    );
    held = rows[0]?.ok === true;
    if (!held) return false;
    await fn();
    return true;
  } finally {
    if (held) {
      await client
        .query("SELECT pg_advisory_unlock($1)", [key])
        .catch(() => {});
    }
    client.release();
  }
}
