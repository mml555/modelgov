import type { Pool } from "pg";

type Queryable = Pick<Pool, "query">;

export interface ErasureResult {
  userId: string;
  requestLogs: number;
  idempotencyKeys: number;
  reservationLeases: number;
  /** When set, erasure was limited to this tenant partition. */
  tenantId?: string;
}

const ERASE_BATCH = 5000;

/**
 * Delete matching rows in bounded batches so no single DELETE statement can
 * exceed the runtime statement_timeout (30s). A heavy user's request_logs could
 * otherwise blow the timeout, roll back the whole erasure transaction (including
 * its audit row), and become impossible to erase. Uses ctid so no per-table PK
 * assumption is needed. `where` and `table` are internal literals; `params` are
 * always parameterized.
 */
async function deleteInBatches(
  pool: Queryable,
  table: string,
  where: string,
  params: unknown[],
): Promise<number> {
  let total = 0;
  for (;;) {
    const res = await pool.query(
      `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT ${ERASE_BATCH})`,
      params,
    );
    const n = res.rowCount ?? 0;
    total += n;
    if (n < ERASE_BATCH) break;
  }
  return total;
}

export interface ErasureParams {
  userId: string;
  /** When set, only rows for this tenant are removed (tenant-bound operator keys). */
  tenantId?: string;
}

/**
 * Right-to-erasure (GDPR Art. 17 / CCPA): remove a user's request-linked data.
 *
 * Erases `request_logs` (per-request audit rows, which carry `user_id` and any
 * captured metadata), `idempotency_keys` (short-lived request state), and
 * `budget_reservation_leases` (in-flight holds, which carry `user_id`).
 * Aggregate spend counters (`budget_counters`) are intentionally NOT deleted —
 * they hold no free-text/PII beyond an opaque scope key and are retained for
 * financial-integrity/auditability. Callers should document that stance in
 * their privacy policy.
 *
 * When `tenantId` is provided, only rows stamped with that tenant are removed —
 * a tenant-scoped operator can't reach another tenant's data, and rows written
 * before tenant stamping (NULL tenant_id) are out of a tenant-scoped erase's
 * reach by design. Platform operators (keys without a tenant binding) omit
 * `tenantId` to erase EVERY row for the user id, including pre-tenanting rows.
 */
export async function eraseUserData(pool: Queryable, params: ErasureParams): Promise<ErasureResult> {
  const { userId, tenantId } = params;
  const where = tenantId ? "user_id = $1 AND tenant_id = $2" : "user_id = $1";
  const values = tenantId ? [userId, tenantId] : [userId];

  const requestLogs = await deleteInBatches(pool, "request_logs", where, values);
  const idempotencyKeys = await deleteInBatches(pool, "idempotency_keys", where, values);
  const reservationLeases = await deleteInBatches(pool, "budget_reservation_leases", where, values);

  return {
    userId,
    ...(tenantId ? { tenantId } : {}),
    requestLogs,
    idempotencyKeys,
    reservationLeases,
  };
}
