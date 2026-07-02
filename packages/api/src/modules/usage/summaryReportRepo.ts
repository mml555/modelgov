import type { Pool } from "pg";

export interface UsageSummaryFilters {
  since: Date;
  projectScope?: string;
  tenantScope?: string;
  feature?: string;
  userType?: string;
}

export interface UsageAggregateRow {
  requests: string;
  completed: string;
  blocked: string;
  degraded: string;
  fallbacks: string;
  safety_blocked: string;
  actual_cost: string;
  estimated_cost: string;
}

export interface CountByCodeRow {
  code: string;
  count: string;
}

export interface CountByModelRow {
  model: string;
  count: string;
}

export async function getUsageAggregate(
  pool: Pool,
  filters: UsageSummaryFilters,
): Promise<UsageAggregateRow | undefined> {
  const { where, values } = usageSummaryWhere(filters);
  const { rows } = await pool.query<UsageAggregateRow>(
    `
    SELECT
      count(*)::text AS requests,
      count(*) FILTER (WHERE status = 'ok')::text AS completed,
      count(*) FILTER (WHERE status = 'failed')::text AS blocked,
      count(*) FILTER (WHERE decision = 'degrade')::text AS degraded,
      count(*) FILTER (WHERE decision = 'fallback')::text AS fallbacks,
      count(*) FILTER (WHERE status = 'safety_blocked')::text AS safety_blocked,
      coalesce(sum(actual_cost_usd), 0)::text AS actual_cost,
      coalesce(sum(estimated_cost_usd), 0)::text AS estimated_cost
    FROM request_logs
    WHERE ${where}
    `,
    values,
  );
  return rows[0];
}

export async function getTopReasonCode(
  pool: Pool,
  filters: UsageSummaryFilters,
): Promise<CountByCodeRow | undefined> {
  const { where, values } = usageSummaryWhere(filters);
  const { rows } = await pool.query<CountByCodeRow>(
    `
    SELECT coalesce(reason_code, 'unknown') AS code, count(*)::text AS count
    FROM request_logs
    WHERE ${where} AND status <> 'ok'
    GROUP BY 1
    ORDER BY count(*) DESC
    LIMIT 1
    `,
    values,
  );
  return rows[0];
}

export async function getTopModelUsed(
  pool: Pool,
  filters: UsageSummaryFilters,
): Promise<CountByModelRow | undefined> {
  const { where, values } = usageSummaryWhere(filters);
  const { rows } = await pool.query<CountByModelRow>(
    `
    SELECT resolved_model AS model, count(*)::text AS count
    FROM request_logs
    WHERE ${where} AND resolved_model IS NOT NULL
    GROUP BY 1
    ORDER BY count(*) DESC
    LIMIT 1
    `,
    values,
  );
  return rows[0];
}

function usageSummaryWhere(filters: UsageSummaryFilters): {
  where: string;
  values: unknown[];
} {
  const conditions = ["created_at >= $1::timestamptz"];
  const values: unknown[] = [filters.since.toISOString()];

  if (filters.tenantScope) {
    values.push(filters.tenantScope);
    conditions.push(`tenant_id = $${values.length}`);
  }
  if (filters.projectScope) {
    values.push(filters.projectScope);
    conditions.push(`project_id = $${values.length}`);
  }
  if (filters.feature) {
    values.push(filters.feature);
    conditions.push(`feature = $${values.length}`);
  }
  if (filters.userType) {
    values.push(filters.userType);
    conditions.push(`user_type = $${values.length}`);
  }

  return { where: conditions.join(" AND "), values };
}
