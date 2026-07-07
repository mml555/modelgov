import type { Pool, PoolClient } from "pg";
import { consumeReservationLease, withTransaction } from "../../db/pool";

export interface BillingAccountRow {
  tenantId: string;
  userId: string;
  stripeCustomerId: string | null;
  userType: string | null;
  creditsUsd: number;
  creditsReservedUsd: number;
}

const SELECT_ACCOUNT = `
  SELECT tenant_id, user_id, stripe_customer_id, user_type,
         credits_usd::float8 AS credits_usd,
         credits_reserved_usd::float8 AS credits_reserved_usd
  FROM billing_accounts
  WHERE tenant_id = $1 AND user_id = $2
`;

export async function getBillingAccount(
  pool: Pool,
  tenantId: string,
  userId: string,
): Promise<BillingAccountRow | null> {
  const { rows } = await pool.query(SELECT_ACCOUNT, [tenantId, userId]);
  const row = rows[0] as
    | {
        tenant_id: string;
        user_id: string;
        stripe_customer_id: string | null;
        user_type: string | null;
        credits_usd: number;
        credits_reserved_usd: number;
      }
    | undefined;
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    stripeCustomerId: row.stripe_customer_id,
    userType: row.user_type,
    creditsUsd: row.credits_usd,
    creditsReservedUsd: row.credits_reserved_usd,
  };
}

export async function upsertBillingAccount(
  pool: Pool,
  params: {
    tenantId: string;
    userId: string;
    stripeCustomerId?: string | null;
    userType?: string | null;
    creditsDeltaUsd?: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO billing_accounts (tenant_id, user_id, stripe_customer_id, user_type, credits_usd)
     VALUES ($1, $2, $3, $4, COALESCE($5, 0))
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET
       stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, billing_accounts.stripe_customer_id),
       user_type = COALESCE(EXCLUDED.user_type, billing_accounts.user_type),
       credits_usd = billing_accounts.credits_usd + COALESCE($5, 0),
       updated_at = now()`,
    [
      params.tenantId,
      params.userId,
      params.stripeCustomerId ?? null,
      params.userType ?? null,
      params.creditsDeltaUsd ?? null,
    ],
  );
}

/**
 * Atomically reserve credits (balance check inside the UPDATE) and record a
 * lease row for the amount. The lease is the crash ledger: if neither settle
 * nor release ever runs (worker crash, settle-write failure), the maintenance
 * sweep finds the stale lease and returns the amount to the wallet.
 */
export async function reserveCredits(
  pool: Pool,
  params: { tenantId: string; userId: string; amountUsd: number; holdId?: string },
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    // A zero-rounded estimate holds nothing (and must not require an account
    // row to exist), but the lease row is still written below: settle is gated
    // on deleting the hold's leases, and the ACTUAL cost of a zero-estimate
    // request can be positive — without the lease it would never be debited.
    if (params.amountUsd > 0) {
      const { rowCount } = await client.query(
        `UPDATE billing_accounts
         SET credits_reserved_usd = credits_reserved_usd + $3, updated_at = now()
         WHERE tenant_id = $1 AND user_id = $2
           AND credits_usd - credits_reserved_usd >= $3`,
        [params.tenantId, params.userId, params.amountUsd],
      );
      if ((rowCount ?? 0) === 0) return false;
    }
    if (params.holdId) {
      await client.query(
        `INSERT INTO billing_reservation_leases (hold_id, tenant_id, user_id, amount_usd)
         VALUES ($1, $2, $3, $4)`,
        [params.holdId, params.tenantId, params.userId, params.amountUsd],
      );
    }
    return true;
  });
}

/**
 * Return a reserved amount to the wallet without booking spend. With a holdId,
 * the release is gated on deleting one amount-matched lease (rows with equal
 * (hold_id, amount) are fungible): a lease already gone means the sweep or a
 * retry released it first, so the wallet is NOT decremented again. Without a
 * holdId (hierarchical requests, which never lease), the legacy unconditional
 * release applies.
 */
export async function releaseCredits(
  pool: Pool,
  params: { tenantId: string; userId: string; amountUsd: number; holdId?: string },
): Promise<void> {
  if (!params.holdId) {
    await pool.query(
      `UPDATE billing_accounts
       SET credits_reserved_usd = GREATEST(credits_reserved_usd - $3, 0), updated_at = now()
       WHERE tenant_id = $1 AND user_id = $2`,
      [params.tenantId, params.userId, params.amountUsd],
    );
    return;
  }
  await withTransaction(pool, async (client) => {
    // Match the amount rounded to the column scale: amount_usd is numeric(14,6),
    // so a lease inserted from a JS float (e.g. 0.30000000000000004) is stored as
    // 0.300000. Comparing against the raw float would match zero rows and skip the
    // wallet decrement, stranding the reservation until the stale-lease sweep.
    // Decrement by the DELETED lease's stored amount (RETURNING), never the raw
    // caller float: the two can diverge (independent rounding) and decrementing by
    // the caller's figure would drift credits_reserved_usd from what was reserved.
    const { rows } = await client.query(
      `DELETE FROM billing_reservation_leases
       WHERE id IN (
         SELECT id FROM billing_reservation_leases
         WHERE hold_id = $1 AND amount_usd = round($2::numeric, 6)
         ORDER BY id
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING amount_usd::float8 AS amount_usd`,
      [params.holdId, params.amountUsd],
    );
    const deleted = rows[0] as { amount_usd: number } | undefined;
    if (!deleted) return; // already released/settled/swept
    await client.query(
      `UPDATE billing_accounts
       SET credits_reserved_usd = GREATEST(credits_reserved_usd - $3, 0), updated_at = now()
       WHERE tenant_id = $1 AND user_id = $2`,
      [params.tenantId, params.userId, deleted.amount_usd],
    );
  });
}

/**
 * Book actual spend against the wallet and release the full reservation.
 * Deliberate overspend policy: `credits_usd` floors at 0 (GREATEST) — when
 * actual cost exceeds the remaining balance (the reserve was an estimate), the
 * excess is forgiven rather than driving the wallet negative. The reservation
 * cap bounds how far a single request can overshoot.
 *
 * With a holdId the settle is gated on deleting the hold's remaining leases:
 * retried settles (or a settle racing the stale-lease sweep) find no leases and
 * skip the wallet update, so a request is never double-booked. The accepted
 * trade-off (mirroring the internal ledger) is that a settle arriving after its
 * own lease was swept undercounts — it never double-charges. Without a holdId
 * (hierarchical requests, which never lease) the legacy unconditional update
 * applies.
 */
export async function settleCredits(
  pool: Pool,
  params: {
    tenantId: string;
    userId: string;
    reservedUsd: number;
    actualUsd: number;
    holdId?: string;
  },
): Promise<void> {
  if (!params.holdId) {
    await pool.query(
      `UPDATE billing_accounts
       SET credits_usd = GREATEST(credits_usd - $3, 0),
           credits_reserved_usd = GREATEST(credits_reserved_usd - $4, 0),
           updated_at = now()
       WHERE tenant_id = $1 AND user_id = $2`,
      [params.tenantId, params.userId, params.actualUsd, params.reservedUsd],
    );
    return;
  }
  await withTransaction(pool, async (client) => {
    // Route the wallet through the shared lease-consume invariant (the same one
    // the flat/hierarchical ledgers use): the settle is gated on deleting the
    // hold's leases, so retries and the stale-lease sweep can't double-book.
    const consumed = await consumeReservationLease(
      client,
      `DELETE FROM billing_reservation_leases WHERE hold_id = $1`,
      params.holdId,
    );
    if (!consumed) return; // already settled or swept — idempotent
    await client.query(
      `UPDATE billing_accounts
       SET credits_usd = GREATEST(credits_usd - $3, 0),
           credits_reserved_usd = GREATEST(credits_reserved_usd - $4, 0),
           updated_at = now()
       WHERE tenant_id = $1 AND user_id = $2`,
      [params.tenantId, params.userId, params.actualUsd, params.reservedUsd],
    );
  });
}

/**
 * Release credit reservations whose lease outlived the reservation TTL — the
 * request that held them crashed or failed to settle. Batched; returns the
 * number of leases released. Per-(tenant,user) aggregation keeps it to one
 * wallet UPDATE per account per pass.
 */
export async function cleanupStaleBillingLeases(
  pool: Pool,
  staleMs: number,
  batch = 500,
): Promise<number> {
  const { rows } = await pool.query(
    `WITH stale AS (
       DELETE FROM billing_reservation_leases
       WHERE id IN (
         SELECT id FROM billing_reservation_leases
         WHERE created_at < now() - ($1 || ' milliseconds')::interval
         ORDER BY created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING tenant_id, user_id, amount_usd
     ),
     agg AS (
       SELECT tenant_id, user_id, SUM(amount_usd) AS amount_usd, COUNT(*)::int AS n
       FROM stale
       GROUP BY tenant_id, user_id
     ),
     upd AS (
       UPDATE billing_accounts a
       SET credits_reserved_usd = GREATEST(a.credits_reserved_usd - agg.amount_usd, 0),
           updated_at = now()
       FROM agg
       WHERE a.tenant_id = agg.tenant_id AND a.user_id = agg.user_id
       RETURNING agg.n
     )
     SELECT COALESCE(SUM(n), 0)::int AS released FROM upd`,
    [String(staleMs), batch],
  );
  return (rows[0] as { released: number } | undefined)?.released ?? 0;
}

export async function findAccountByStripeCustomer(
  pool: Pool,
  stripeCustomerId: string,
): Promise<BillingAccountRow | null> {
  const { rows } = await pool.query(
    `SELECT tenant_id, user_id, stripe_customer_id, user_type,
            credits_usd::float8 AS credits_usd,
            credits_reserved_usd::float8 AS credits_reserved_usd
     FROM billing_accounts
     WHERE stripe_customer_id = $1
     LIMIT 1`,
    [stripeCustomerId],
  );
  const row = rows[0] as
    | {
        tenant_id: string;
        user_id: string;
        stripe_customer_id: string | null;
        user_type: string | null;
        credits_usd: number;
        credits_reserved_usd: number;
      }
    | undefined;
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    stripeCustomerId: row.stripe_customer_id,
    userType: row.user_type,
    creditsUsd: row.credits_usd,
    creditsReservedUsd: row.credits_reserved_usd,
  };
}

export async function recordMeterEvent(
  client: PoolClient,
  params: {
    requestId: string;
    tenantId: string;
    userId: string;
    feature: string;
    costUsd: number;
  },
): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO meter_events (request_id, tenant_id, user_id, feature, cost_usd)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (request_id) DO NOTHING`,
    [params.requestId, params.tenantId, params.userId, params.feature, params.costUsd],
  );
  return (rowCount ?? 0) > 0;
}

export async function markMeterReported(
  pool: Pool,
  requestId: string,
  stripeEventId?: string,
): Promise<void> {
  await pool.query(
    `UPDATE meter_events
     SET reported_at = now(), stripe_event_id = COALESCE($2, stripe_event_id)
     WHERE request_id = $1`,
    [requestId, stripeEventId ?? null],
  );
}

/**
 * After this many failed report attempts a meter row is considered poison
 * (permanently unreportable — deleted Stripe customer, bad meter name) and is
 * skipped by the flush so it can't starve newer rows; the retention sweep then
 * prunes it and logs the unbilled usage. Permanent (4xx) failures jump straight
 * to this ceiling instead of burning through the retries.
 */
export const MAX_METER_ATTEMPTS = 10;

export async function listPendingMeterEvents(
  pool: Pool,
  // Reported with bounded concurrency (see flushPendingMeters), so a larger batch
  // drains a backlog within one tick instead of ~50/min. Sized so the fan-out
  // still finishes well inside the maintenance interval.
  limit = 500,
): Promise<
  Array<{
    requestId: string;
    tenantId: string;
    userId: string;
    feature: string;
    costUsd: number;
    stripeCustomerId: string;
    attempts: number;
    createdAtMs: number;
  }>
> {
  // Only rows whose account has a Stripe customer are reportable. Rows without
  // one must not be returned: they can never flush, and with this batch's
  // ORDER BY + LIMIT they would permanently occupy batch slots and starve
  // newer events (the retention sweep prunes them instead). Also skip rows still
  // in backoff (next_attempt_at) and rows past the retry ceiling (poison) so a
  // handful of permanently-failing events can never block the whole flush.
  const { rows } = await pool.query(
    `SELECT m.request_id, m.tenant_id, m.user_id, m.feature,
            m.cost_usd::float8 AS cost_usd, m.attempts,
            (extract(epoch from m.created_at) * 1000)::float8 AS created_at_ms,
            a.stripe_customer_id
     FROM meter_events m
     JOIN billing_accounts a
       ON a.tenant_id = m.tenant_id AND a.user_id = m.user_id
     WHERE m.reported_at IS NULL
       AND a.stripe_customer_id IS NOT NULL
       AND m.attempts < $2
       AND m.next_attempt_at <= now()
     ORDER BY m.next_attempt_at ASC, m.created_at ASC
     LIMIT $1`,
    [limit, MAX_METER_ATTEMPTS],
  );
  return (rows as Array<{
    request_id: string;
    tenant_id: string;
    user_id: string;
    feature: string;
    cost_usd: number;
    stripe_customer_id: string;
    attempts: number;
    created_at_ms: number;
  }>).map((r) => ({
    requestId: r.request_id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    feature: r.feature,
    costUsd: r.cost_usd,
    stripeCustomerId: r.stripe_customer_id,
    attempts: r.attempts,
    createdAtMs: r.created_at_ms,
  }));
}

/**
 * Record a failed meter-report attempt: bump the attempt count, stash the error,
 * and push next_attempt_at out with exponential backoff. A permanent failure
 * (Stripe 4xx) jumps straight to the retry ceiling so the flush skips it
 * immediately instead of retrying a request that will never succeed.
 */
export async function recordMeterFailure(
  pool: Pool,
  requestId: string,
  errorMessage: string,
  opts: { permanent: boolean; attempts: number },
): Promise<void> {
  const nextAttempts = opts.permanent ? MAX_METER_ATTEMPTS : opts.attempts + 1;
  // 1min, 2, 4, 8, ... capped at 6h. Permanent failures don't retry.
  const backoffMs = opts.permanent
    ? 0
    : Math.min(60_000 * 2 ** opts.attempts, 6 * 60 * 60 * 1000);
  await pool.query(
    `UPDATE meter_events
     SET attempts = $2,
         last_error = $3,
         next_attempt_at = now() + ($4 || ' milliseconds')::interval
     WHERE request_id = $1`,
    [requestId, nextAttempts, errorMessage.slice(0, 500), String(backoffMs)],
  );
}

/**
 * Retention for meter_events. Reported rows served their purpose (the Stripe
 * meter has the usage) and are kept only for a debugging window. Unreported rows
 * are dropped only when they can NEVER be reported — the account has no Stripe
 * customer id; a row whose account was linked later stays pending so the meter
 * flush still invoices it (real usage is not silently dropped). Both sweeps drain
 * in a loop so a large backlog clears in one pass instead of one batch per tick;
 * the abandoned count is returned separately so the caller can warn on it.
 */
export async function cleanupMeterEvents(
  pool: Pool,
  opts: { reportedRetentionMs: number; abandonedRetentionMs: number },
  batch = 5000,
): Promise<{ reported: number; abandoned: number }> {
  let reported = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM meter_events
       WHERE request_id IN (
         SELECT request_id FROM meter_events
         WHERE reported_at IS NOT NULL
           AND reported_at < now() - ($1 || ' milliseconds')::interval
         LIMIT $2
       )`,
      [String(opts.reportedRetentionMs), batch],
    );
    const n = rowCount ?? 0;
    reported += n;
    if (n < batch) break;
  }
  let abandoned = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM meter_events
       WHERE request_id IN (
         SELECT m.request_id FROM meter_events m
         WHERE m.reported_at IS NULL
           AND m.created_at < now() - ($1 || ' milliseconds')::interval
           AND (
             -- never linkable to a Stripe customer, so never reportable
             NOT EXISTS (
               SELECT 1 FROM billing_accounts a
               WHERE a.tenant_id = m.tenant_id
                 AND a.user_id = m.user_id
                 AND a.stripe_customer_id IS NOT NULL
             )
             -- or exhausted the retry ceiling (poison: e.g. deleted customer,
             -- bad meter name) — Stripe keeps rejecting it, so drop it.
             OR m.attempts >= $3
           )
         LIMIT $2
       )`,
      [String(opts.abandonedRetentionMs), batch, MAX_METER_ATTEMPTS],
    );
    const n = rowCount ?? 0;
    abandoned += n;
    if (n < batch) break;
  }
  return { reported, abandoned };
}

/**
 * Retention for Stripe webhook idempotency records. Stripe retries webhooks
 * for days, not months; rows older than the retention window can no longer be
 * replayed by Stripe, so keeping them buys no protection.
 */
export async function cleanupStripeProcessedEvents(
  pool: Pool,
  retentionMs: number,
  batch = 5000,
): Promise<number> {
  let removed = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM stripe_processed_events
       WHERE event_id IN (
         SELECT event_id FROM stripe_processed_events
         WHERE processed_at < now() - ($1 || ' milliseconds')::interval
         LIMIT $2
       )`,
      [String(retentionMs), batch],
    );
    const n = rowCount ?? 0;
    removed += n;
    if (n < batch) break;
  }
  return removed;
}

export async function topUpCreditsInTransaction(
  pool: Pool,
  params: {
    tenantId: string;
    userId: string;
    creditsUsd: number;
    stripeCustomerId?: string;
    userType?: string;
    /** When set, the grant is idempotent per Stripe event id (replay-safe). */
    stripeEventId?: string;
  },
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    if (params.stripeEventId) {
      const { rowCount } = await client.query(
        `INSERT INTO stripe_processed_events (event_id) VALUES ($1)
         ON CONFLICT (event_id) DO NOTHING`,
        [params.stripeEventId],
      );
      // Already processed (Stripe re-delivery or operator replay) — skip the
      // grant so credits are added at most once for this event.
      if ((rowCount ?? 0) === 0) return false;
    }
    await client.query(
      `INSERT INTO billing_accounts (tenant_id, user_id, stripe_customer_id, user_type, credits_usd)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET
         credits_usd = billing_accounts.credits_usd + EXCLUDED.credits_usd,
         stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, billing_accounts.stripe_customer_id),
         user_type = COALESCE(EXCLUDED.user_type, billing_accounts.user_type),
         updated_at = now()`,
      [
        params.tenantId,
        params.userId,
        params.stripeCustomerId ?? null,
        params.userType ?? null,
        params.creditsUsd,
      ],
    );
    return true;
  });
}
