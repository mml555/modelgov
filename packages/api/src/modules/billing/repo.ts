import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../db/pool";

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

export async function reserveCredits(
  pool: Pool,
  params: { tenantId: string; userId: string; amountUsd: number },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE billing_accounts
     SET credits_reserved_usd = credits_reserved_usd + $3, updated_at = now()
     WHERE tenant_id = $1 AND user_id = $2
       AND credits_usd - credits_reserved_usd >= $3`,
    [params.tenantId, params.userId, params.amountUsd],
  );
  return (rowCount ?? 0) > 0;
}

export async function releaseCredits(
  pool: Pool,
  params: { tenantId: string; userId: string; amountUsd: number },
): Promise<void> {
  await pool.query(
    `UPDATE billing_accounts
     SET credits_reserved_usd = GREATEST(credits_reserved_usd - $3, 0), updated_at = now()
     WHERE tenant_id = $1 AND user_id = $2`,
    [params.tenantId, params.userId, params.amountUsd],
  );
}

export async function settleCredits(
  pool: Pool,
  params: { tenantId: string; userId: string; reservedUsd: number; actualUsd: number },
): Promise<void> {
  const refund = Math.max(params.reservedUsd - params.actualUsd, 0);
  await pool.query(
    `UPDATE billing_accounts
     SET credits_usd = GREATEST(credits_usd - $3, 0),
         credits_reserved_usd = GREATEST(credits_reserved_usd - $4, 0),
         updated_at = now()
     WHERE tenant_id = $1 AND user_id = $2`,
    [params.tenantId, params.userId, params.actualUsd, params.reservedUsd],
  );
  if (refund > 0) {
    // reserved was higher than actual — settleCredits already released the full
    // reservation; the GREATEST on credits_usd books actual spend only.
  }
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

export async function listPendingMeterEvents(
  pool: Pool,
  limit = 50,
): Promise<
  Array<{
    requestId: string;
    tenantId: string;
    userId: string;
    feature: string;
    costUsd: number;
  }>
> {
  const { rows } = await pool.query(
    `SELECT request_id, tenant_id, user_id, feature, cost_usd::float8 AS cost_usd
     FROM meter_events
     WHERE reported_at IS NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );
  return (rows as Array<{
    request_id: string;
    tenant_id: string;
    user_id: string;
    feature: string;
    cost_usd: number;
  }>).map((r) => ({
    requestId: r.request_id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    feature: r.feature,
    costUsd: r.cost_usd,
  }));
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
