import type { ReservationCaps, UsageSnapshot } from "@ai-guard/policy-engine";
import type { Pool } from "pg";
import { withTransaction } from "../../db/pool";
import { dayWindowStart, monthWindowStart } from "../../services/windows";

// lock_timeout for the budget-counter transactions: a contended row must fail
// fast rather than pile up connections behind a long lock wait.
const LOCK_TIMEOUT_MS = 3000;

/**
 * Thrown inside a reserve/top-up transaction when a dimension breaches its cap,
 * so `withTransaction` rolls the whole (partial) reservation back. Caught by the
 * caller and mapped to a `{ ok: false }` result rather than propagated.
 */
class ReservationRejected extends Error {
  constructor(readonly scope: Scope) {
    super(`reservation rejected on scope ${scope}`);
    this.name = "ReservationRejected";
  }
}

// All Postgres reads/writes for budget accounting live here. The pure engine
// never touches the DB; it consumes the UsageSnapshot this repo loads.
//
// user_daily + feature_monthly counters are scoped by project_id.
// global_monthly is deployment-wide (project_id = '').

type Scope = "user_daily" | "feature_monthly" | "global_monthly";

export type BudgetScope = Scope;

/** Empty project_id marks deployment-wide dimensions (global monthly). */
export const GLOBAL_PROJECT_ID = "";

interface Dimension {
  tenantId: string;
  scope: Scope;
  projectId: string;
  key: string;
  windowStart: string;
  usdCap: number | null;
  reqCap: number | null;
  reqDelta: number;
  tokenCap: number | null;
}

export interface ReserveParams {
  projectId: string;
  userId: string;
  feature: string;
  estimatedCostUsd: number;
  /** Worst-case token estimate reserved alongside cost (0 = no token tracking). */
  estimatedTokens?: number;
  caps: ReservationCaps;
  now: Date;
  /** Tenant partition for the counters ('' = untenanted / single-tenant). */
  tenantId?: string;
}

export interface ReserveResult {
  ok: boolean;
  failedScope?: Scope;
  leaseId?: string;
}

interface WindowOverride {
  day: string;
  month: string;
}

function dimensionsFor(
  tenantId: string,
  projectId: string,
  userId: string,
  feature: string,
  caps: ReservationCaps,
  now: Date,
  windows?: WindowOverride,
): Dimension[] {
  const day = windows?.day ?? dayWindowStart(now);
  const month = windows?.month ?? monthWindowStart(now);
  // global_monthly stays deployment-wide WITHIN a tenant (project_id ''), but the
  // tenant_id column now separates one tenant's global counter from another's.
  return [
    {
      tenantId,
      scope: "user_daily",
      projectId,
      key: userId,
      windowStart: day,
      usdCap: caps.userDailyUsd,
      reqCap: caps.userDailyRequests,
      reqDelta: 1,
      tokenCap: caps.userDailyTokens ?? null,
    },
    {
      tenantId,
      scope: "feature_monthly",
      projectId,
      key: feature,
      windowStart: month,
      usdCap: caps.featureMonthlyUsd,
      reqCap: null,
      reqDelta: 0,
      tokenCap: caps.featureMonthlyTokens ?? null,
    },
    {
      tenantId,
      scope: "global_monthly",
      projectId: GLOBAL_PROJECT_ID,
      key: "global",
      windowStart: month,
      usdCap: caps.globalMonthlyUsd,
      reqCap: null,
      reqDelta: 0,
      tokenCap: caps.globalMonthlyTokens ?? null,
    },
  ];
}

const SNAPSHOT_SQL = `
  SELECT scope, used_usd, reserved_usd, requests_used, used_tokens, reserved_tokens
  FROM budget_counters
  WHERE tenant_id = $6 AND (
        (scope = 'user_daily'      AND project_id = $1 AND key = $2 AND window_start = $3)
     OR (scope = 'feature_monthly' AND project_id = $1 AND key = $4 AND window_start = $5)
     OR (scope = 'global_monthly'  AND project_id = ''  AND key = 'global' AND window_start = $5)
  )
`;

/** Read used + reserved for the three budget dimensions of this request. */
export async function loadUsageSnapshot(
  pool: Pool,
  params: { projectId: string; userId: string; feature: string; now: Date; tenantId?: string },
): Promise<UsageSnapshot> {
  const day = dayWindowStart(params.now);
  const month = monthWindowStart(params.now);
  const { rows } = await pool.query(SNAPSHOT_SQL, [
    params.projectId,
    params.userId,
    day,
    params.feature,
    month,
    params.tenantId ?? "",
  ]);

  const snapshot: UsageSnapshot = {
    userDailyUsdUsed: 0,
    userDailyUsdReserved: 0,
    userDailyRequestsUsed: 0,
    featureMonthlyUsdUsed: 0,
    featureMonthlyUsdReserved: 0,
    globalMonthlyUsdUsed: 0,
    globalMonthlyUsdReserved: 0,
    userDailyTokensUsed: 0,
    userDailyTokensReserved: 0,
    featureMonthlyTokensUsed: 0,
    featureMonthlyTokensReserved: 0,
    globalMonthlyTokensUsed: 0,
    globalMonthlyTokensReserved: 0,
  };

  for (const row of rows as Array<{
    scope: Scope;
    used_usd: string;
    reserved_usd: string;
    requests_used: number;
    used_tokens: string;
    reserved_tokens: string;
  }>) {
    const used = Number(row.used_usd);
    const reserved = Number(row.reserved_usd);
    const usedTokens = Number(row.used_tokens);
    const reservedTokens = Number(row.reserved_tokens);
    if (row.scope === "user_daily") {
      snapshot.userDailyUsdUsed = used;
      snapshot.userDailyUsdReserved = reserved;
      snapshot.userDailyRequestsUsed = Number(row.requests_used);
      snapshot.userDailyTokensUsed = usedTokens;
      snapshot.userDailyTokensReserved = reservedTokens;
    } else if (row.scope === "feature_monthly") {
      snapshot.featureMonthlyUsdUsed = used;
      snapshot.featureMonthlyUsdReserved = reserved;
      snapshot.featureMonthlyTokensUsed = usedTokens;
      snapshot.featureMonthlyTokensReserved = reservedTokens;
    } else {
      snapshot.globalMonthlyUsdUsed = used;
      snapshot.globalMonthlyUsdReserved = reserved;
      snapshot.globalMonthlyTokensUsed = usedTokens;
      snapshot.globalMonthlyTokensReserved = reservedTokens;
    }
  }
  return snapshot;
}

// The cap must be enforced on BOTH the first reservation of a window and every
// subsequent one. The DO UPDATE ... WHERE guards the conflict (existing-row)
// path; the INSERT ... SELECT ... WHERE guards the fresh-row path — without it,
// the very first request of a scope/window would insert unconditionally and
// slip past the cap. On a fresh window "used + reserved" is 0, so the fresh-row
// check is simply "this reservation alone <= cap".
const RESERVE_SQL = `
  INSERT INTO budget_counters (scope, project_id, key, window_start, used_usd, reserved_usd, requests_used, used_tokens, reserved_tokens, tenant_id)
  SELECT $1, $2, $3, $4, 0, $5, $6, 0, $9, $11
  WHERE ($7::numeric IS NULL OR $5::numeric <= $7::numeric)
    AND ($8::int IS NULL OR $6::int <= $8::int)
    AND ($10::bigint IS NULL OR $9::bigint <= $10::bigint)
  ON CONFLICT (tenant_id, scope, project_id, key, window_start) DO UPDATE
    SET reserved_usd    = budget_counters.reserved_usd + EXCLUDED.reserved_usd,
        requests_used   = budget_counters.requests_used + EXCLUDED.requests_used,
        reserved_tokens = budget_counters.reserved_tokens + EXCLUDED.reserved_tokens
    WHERE ($7::numeric IS NULL
           OR budget_counters.used_usd + budget_counters.reserved_usd + EXCLUDED.reserved_usd <= $7::numeric)
      AND ($8::int IS NULL
           OR budget_counters.requests_used + EXCLUDED.requests_used <= $8::int)
      AND ($10::bigint IS NULL
           OR budget_counters.used_tokens + budget_counters.reserved_tokens + EXCLUDED.reserved_tokens <= $10::bigint)
  RETURNING reserved_usd
`;

export async function reserveBudget(
  pool: Pool,
  params: ReserveParams,
): Promise<ReserveResult> {
  const tenantId = params.tenantId ?? "";
  const dims = dimensionsFor(
    tenantId,
    params.projectId,
    params.userId,
    params.feature,
    params.caps,
    params.now,
  );
  const day = dims[0]!.windowStart;
  const month = dims[1]!.windowStart;
  const estTokens = params.estimatedTokens ?? 0;
  try {
    const leaseId = await withTransaction(
      pool,
      async (client) => {
        for (const d of dims) {
          const res = await client.query(RESERVE_SQL, [
            d.scope,
            d.projectId,
            d.key,
            d.windowStart,
            params.estimatedCostUsd,
            d.reqDelta,
            d.usdCap,
            d.reqCap,
            estTokens,
            d.tokenCap,
            d.tenantId,
          ]);
          if (res.rowCount === 0) throw new ReservationRejected(d.scope);
        }
        const lease = await client.query<{ id: string }>(LEASE_INSERT_SQL, [
          params.projectId,
          params.userId,
          params.feature,
          params.estimatedCostUsd,
          JSON.stringify(params.caps),
          day,
          month,
          estTokens,
          tenantId,
        ]);
        return lease.rows[0]?.id;
      },
      { lockTimeoutMs: LOCK_TIMEOUT_MS },
    );
    return { ok: true, leaseId };
  } catch (err) {
    if (err instanceof ReservationRejected) {
      return { ok: false, failedScope: err.scope };
    }
    throw err;
  }
}

export interface TopUpParams {
  projectId: string;
  userId: string;
  feature: string;
  additionalCostUsd: number;
  caps: ReservationCaps;
  now: Date;
  leaseId?: string;
  tenantId?: string;
}

/** Increase an in-flight reservation when the fallback model costs more than the primary estimate. */
export async function topUpBudget(
  pool: Pool,
  params: TopUpParams,
): Promise<ReserveResult> {
  if (params.additionalCostUsd <= 0) {
    return { ok: true, leaseId: params.leaseId };
  }
  const dims = dimensionsFor(
    params.tenantId ?? "",
    params.projectId,
    params.userId,
    params.feature,
    params.caps,
    params.now,
  );
  try {
    await withTransaction(
      pool,
      async (client) => {
        for (const d of dims) {
          // Fallback top-up adds cost only; token estimate is unchanged
          // (maxOutputTokens is feature-level), so token delta is 0.
          const res = await client.query(RESERVE_SQL, [
            d.scope,
            d.projectId,
            d.key,
            d.windowStart,
            params.additionalCostUsd,
            0,
            d.usdCap,
            d.reqCap,
            0,
            d.tokenCap,
            d.tenantId,
          ]);
          if (res.rowCount === 0) throw new ReservationRejected(d.scope);
        }
        if (params.leaseId) {
          await client.query(
            `UPDATE budget_reservation_leases
             SET estimated_cost = estimated_cost + $2::numeric
             WHERE id = $1::bigint`,
            [params.leaseId, params.additionalCostUsd],
          );
        }
      },
      { lockTimeoutMs: LOCK_TIMEOUT_MS },
    );
    return { ok: true, leaseId: params.leaseId };
  } catch (err) {
    if (err instanceof ReservationRejected) {
      return { ok: false, failedScope: err.scope };
    }
    throw err;
  }
}

const RECORD_SQL = `
  UPDATE budget_counters
  SET used_usd        = used_usd + $5::numeric,
      reserved_usd    = GREATEST(reserved_usd - $6::numeric, 0),
      used_tokens     = used_tokens + $7::bigint,
      reserved_tokens = GREATEST(reserved_tokens - $8::bigint, 0)
  WHERE scope = $1 AND project_id = $2 AND key = $3 AND window_start = $4 AND tenant_id = $9
`;

export async function recordActualCost(
  pool: Pool,
  params: {
    projectId: string;
    userId: string;
    feature: string;
    actualCostUsd: number;
    estimatedCostUsd: number;
    actualTokens?: number;
    estimatedTokens?: number;
    caps: ReservationCaps;
    now: Date;
    leaseId?: string;
    tenantId?: string;
  },
): Promise<void> {
  const dims = dimensionsFor(
    params.tenantId ?? "",
    params.projectId,
    params.userId,
    params.feature,
    params.caps,
    params.now,
  );
  await withTransaction(
    pool,
    async (client) => {
      // The lease row is the authoritative, single-use token for this
      // reservation's hold. Delete it FIRST and make the WHOLE settle conditional
      // on the row actually being removed. If it's already gone, this settle is a
      // no-op: either (a) a caller retried a settle that already committed (the
      // pipeline retries recordActualCost once — booking used_usd again here would
      // double-charge the customer), or (b) the stale-lease sweep freed the hold,
      // in which case decrementing reserved_usd again would double-free OTHER
      // in-flight requests' holds on a shared scope and let them overshoot the cap.
      // Gating both used_usd AND reserved_usd on the delete makes settle idempotent
      // under retry — the lease is consumed exactly once, so the spend is booked
      // exactly once. The only cost is that a settle arriving AFTER its own lease
      // was swept (request outlived RESERVATION_STALE_MS — a pathological case the
      // boot check already warns about) won't book its used_usd; that undercounts
      // rather than double-charges, the safe direction for a budget gate. Deleting
      // the lease before the counter update also keeps a consistent lease→counter
      // lock order with the sweep, avoiding a deadlock window.
      const holdOutstanding = params.leaseId
        ? ((await client.query(LEASE_DELETE_SQL, [params.leaseId])).rowCount ?? 0) > 0
        : true;
      if (!holdOutstanding) return;
      for (const d of dims) {
        await client.query(RECORD_SQL, [
          d.scope,
          d.projectId,
          d.key,
          d.windowStart,
          params.actualCostUsd,
          params.estimatedCostUsd,
          params.actualTokens ?? 0,
          params.estimatedTokens ?? 0,
          d.tenantId,
        ]);
      }
    },
    { lockTimeoutMs: LOCK_TIMEOUT_MS },
  );
}

// Books already-spent money with NO cap check and NO reservation change: the
// fresh-window INSERT is unconditional and the conflict path only adds to
// used_usd. Deliberately unlike RESERVE_SQL — this is accounting, not a gate.
const INCUR_SQL = `
  INSERT INTO budget_counters (scope, project_id, key, window_start, used_usd, reserved_usd, requests_used, used_tokens, reserved_tokens, tenant_id)
  VALUES ($1, $2, $3, $4, $5, 0, 0, 0, 0, $6)
  ON CONFLICT (tenant_id, scope, project_id, key, window_start) DO UPDATE
    SET used_usd = budget_counters.used_usd + EXCLUDED.used_usd
`;

/**
 * Book cost that was already spent outside a reservation — the input-safety
 * classifier makes a billable provider call BEFORE the budget is reserved, so
 * when the request is then blocked (safety block, reservation failure, provider
 * failure) that real spend must still land in used_usd. No cap check, no
 * reservation change, no lease: a safety block must stay a safety block, never
 * flip to budget_exceeded because booking the classifier pushed a counter over
 * its cap. The overshoot surfaces on the NEXT request's policy gate instead.
 */
export async function recordIncurredCost(
  pool: Pool,
  params: {
    projectId: string;
    userId: string;
    feature: string;
    costUsd: number;
    caps: ReservationCaps;
    now: Date;
    tenantId?: string;
  },
): Promise<void> {
  if (params.costUsd <= 0) return;
  const dims = dimensionsFor(
    params.tenantId ?? "",
    params.projectId,
    params.userId,
    params.feature,
    params.caps,
    params.now,
  );
  await withTransaction(
    pool,
    async (client) => {
      for (const d of dims) {
        await client.query(INCUR_SQL, [
          d.scope,
          d.projectId,
          d.key,
          d.windowStart,
          params.costUsd,
          d.tenantId,
        ]);
      }
    },
    { lockTimeoutMs: LOCK_TIMEOUT_MS },
  );
}

const RELEASE_SQL = `
  UPDATE budget_counters
  SET reserved_usd    = GREATEST(reserved_usd - $5::numeric, 0),
      requests_used   = GREATEST(requests_used - $6::int, 0),
      reserved_tokens = GREATEST(reserved_tokens - $7::bigint, 0)
  WHERE scope = $1 AND project_id = $2 AND key = $3 AND window_start = $4 AND tenant_id = $8
`;

const LEASE_INSERT_SQL = `
  INSERT INTO budget_reservation_leases
    (project_id, user_id, feature, estimated_cost, caps, window_day, window_month, estimated_tokens, tenant_id)
  VALUES ($1, $2, $3, $4, $5::jsonb, $6::date, $7::date, $8::bigint, $9)
  RETURNING id::text
`;

const LEASE_DELETE_SQL = `DELETE FROM budget_reservation_leases WHERE id = $1::bigint`;

export async function releaseBudget(
  pool: Pool,
  params: {
    projectId: string;
    userId: string;
    feature: string;
    estimatedCostUsd: number;
    estimatedTokens?: number;
    caps: ReservationCaps;
    now: Date;
    windows?: WindowOverride;
    leaseId?: string;
    tenantId?: string;
  },
): Promise<void> {
  const dims = dimensionsFor(
    params.tenantId ?? "",
    params.projectId,
    params.userId,
    params.feature,
    params.caps,
    params.now,
    params.windows,
  );
  await withTransaction(
    pool,
    async (client) => {
      // Same lease-as-authoritative-token rule as recordActualCost: delete the
      // lease first and only free the hold if this transaction actually removed
      // it. If the row is gone the sweep (or a settle) already released this
      // reservation, so releasing again would double-free the shared counters.
      // A release with no lease id (leases disabled) always frees, preserving
      // prior behaviour.
      if (params.leaseId) {
        const del = await client.query(LEASE_DELETE_SQL, [params.leaseId]);
        if ((del.rowCount ?? 0) === 0) return;
      }
      for (const d of dims) {
        await client.query(RELEASE_SQL, [
          d.scope,
          d.projectId,
          d.key,
          d.windowStart,
          params.estimatedCostUsd,
          d.reqDelta,
          params.estimatedTokens ?? 0,
          d.tenantId,
        ]);
      }
    },
    { lockTimeoutMs: LOCK_TIMEOUT_MS },
  );
}
