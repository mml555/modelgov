import type { Pool } from "pg";

// Postgres-backed idempotency store for POST /v1/chat. The atomic claim is the
// crux: INSERT ... ON CONFLICT DO NOTHING lets exactly one concurrent request
// own a key; the rest observe the existing row.

export interface ExistingKey {
  requestHash: string;
  status: "processing" | "completed";
  responseStatus: number | null;
  responseBody: unknown;
}

export type ClaimResult =
  | { state: "claimed" }
  | { state: "conflict"; existing: ExistingKey };

// tenant_id is normalized to '' (never NULL) — see migration 0020 — so it is a
// first-class part of the key identity and the ON CONFLICT target.
const CLAIM_SQL = `
  INSERT INTO idempotency_keys (key, user_id, request_hash, status, claimed_at, tenant_id)
  VALUES ($1, $2, $3, 'processing', now(), $4)
  ON CONFLICT (tenant_id, user_id, key) DO NOTHING
  RETURNING key
`;

const SELECT_SQL = `
  SELECT request_hash, status, response_status, response_body
  FROM idempotency_keys
  WHERE user_id = $1 AND key = $2 AND tenant_id = $3
`;

/**
 * Atomically claim a key. Returns {state:"claimed"} for the first caller; for a
 * subsequent caller returns {state:"conflict"} with the existing row so the
 * caller can replay (completed), reject reuse (hash mismatch), or 409 (in-flight).
 */
export async function claimKey(
  pool: Pool,
  params: { key: string; userId: string; requestHash: string; tenantId?: string },
  attempt = 0,
): Promise<ClaimResult> {
  const tenantId = params.tenantId ?? "";
  const inserted = await pool.query(CLAIM_SQL, [
    params.key,
    params.userId,
    params.requestHash,
    tenantId,
  ]);
  if (inserted.rowCount === 1) return { state: "claimed" };

  const { rows } = await pool.query(SELECT_SQL, [params.userId, params.key, tenantId]);
  const row = rows[0] as
    | {
        request_hash: string;
        status: "processing" | "completed";
        response_status: number | null;
        response_body: unknown;
      }
    | undefined;
  if (!row) {
    // The owner released the row between our INSERT and SELECT. Retry a bounded
    // number of times, then give up — an unbounded recursion under a pathological
    // claim/release race could otherwise grow the stack / hang the request.
    if (attempt >= 3) {
      throw new Error("idempotency key claim did not converge after retries");
    }
    return claimKey(pool, params, attempt + 1);
  }
  return {
    state: "conflict",
    existing: {
      requestHash: row.request_hash,
      status: row.status,
      responseStatus: row.response_status,
      responseBody: row.response_body,
    },
  };
}

const COMPLETE_SQL = `
  UPDATE idempotency_keys
  SET status = 'completed',
      response_status = $3,
      response_body = $4,
      completed_at = now()
  WHERE user_id = $1 AND key = $2 AND tenant_id = $5
`;

/** Store the final result so future retries replay it. */
export async function completeKey(
  pool: Pool,
  params: {
    userId: string;
    key: string;
    responseStatus: number;
    responseBody: unknown;
    tenantId?: string;
  },
): Promise<void> {
  await pool.query(COMPLETE_SQL, [
    params.userId,
    params.key,
    params.responseStatus,
    JSON.stringify(params.responseBody),
    params.tenantId ?? "",
  ]);
}

/** Drop the claim so the client can retry (used on transient 5xx failures). */
export async function releaseKey(
  pool: Pool,
  params: { userId: string; key: string; tenantId?: string },
): Promise<void> {
  await pool.query(
    "DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND tenant_id = $3",
    [params.userId, params.key, params.tenantId ?? ""],
  );
}

/** Remove stale in-flight claims left by crashed workers. */
export async function cleanupStaleIdempotencyKeys(
  pool: Pool,
  staleMs: number,
  now = Date.now(),
): Promise<number> {
  const cutoff = new Date(now - staleMs).toISOString();
  const res = await pool.query(
    `
    DELETE FROM idempotency_keys
    WHERE status = 'processing' AND claimed_at < $1::timestamptz
    `,
    [cutoff],
  );
  return res.rowCount ?? 0;
}

const COMPLETED_CLEANUP_SQL = `
  DELETE FROM idempotency_keys
  WHERE (tenant_id, user_id, key) IN (
    SELECT tenant_id, user_id, key FROM idempotency_keys
    WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at < $1::timestamptz
    LIMIT $2
  )
`;

/**
 * Remove completed replay rows past retention so the table doesn't grow
 * forever. Deletes in bounded batches (like the request_logs sweep) so the
 * first sweep over a large backlog doesn't hold a long lock.
 */
export async function cleanupCompletedIdempotencyKeys(
  pool: Pool,
  retentionMs: number,
  now = Date.now(),
  batchSize = 5000,
): Promise<number> {
  const cutoff = new Date(now - retentionMs).toISOString();
  let total = 0;
  for (;;) {
    const res = await pool.query(COMPLETED_CLEANUP_SQL, [cutoff, batchSize]);
    const removed = res.rowCount ?? 0;
    total += removed;
    if (removed < batchSize) break;
  }
  return total;
}
