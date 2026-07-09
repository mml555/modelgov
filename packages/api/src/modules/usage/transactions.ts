import type { Pool } from "pg";
import { appendRequestLogTenantScope } from "../../db/requestLogScope";
import { parseSince } from "../../util/timeWindow";

// Per-transaction (per-correlation-id) cost rollup. A "transaction" is every
// request_logs row sharing one correlation_id (the reused x-request-id) —
// spanning LLM calls AND externally-ingested non-LLM cost (decision='external').
// See docs/design/cost-attribution.md.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface TransactionRollupQuery {
  since?: string;
  limit?: number;
  projectScope?: string;
  tenantScope?: string;
}

export interface TransactionSummary {
  correlationId: string;
  /** LLM gateway calls in this transaction (excludes external cost rows). */
  requests: number;
  /** Externally-ingested non-LLM cost events (e.g. Azure DI). */
  externalEvents: number;
  /** Total actual cost = llmCostUsd + externalCostUsd. */
  actualCostUsd: number;
  /** Metered LLM cost only. */
  llmCostUsd: number;
  /** Caller-asserted non-LLM cost only. Kept separate so metered and asserted
   *  spend are never blurred. */
  externalCostUsd: number;
  /** Reserved/estimated cost — the fallback ordering key for in-flight
   *  transactions whose LLM rows haven't settled (actual still 0). */
  estimatedCostUsd: number;
  firstSeen: string;
  lastSeen: string;
}

export interface TransactionRollupReport {
  since: string;
  limit: number;
  transactions: TransactionSummary[];
}

interface RollupRow {
  correlation_id: string;
  requests: string;
  external_events: string;
  actual_cost: string;
  llm_actual_cost: string;
  external_actual_cost: string;
  estimated_cost: string;
  first_seen: Date;
  last_seen: Date;
}

export async function getTransactionRollup(
  pool: Pool,
  query: TransactionRollupQuery,
): Promise<TransactionRollupReport> {
  const since = parseSince(query.since ?? "24h");
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  // correlation_id IS NOT NULL skips pre-migration rows (no correlation key).
  const conditions = ["created_at >= $1::timestamptz", "correlation_id IS NOT NULL"];
  const values: unknown[] = [since.toISOString()];
  appendRequestLogTenantScope(conditions, values, query.tenantScope);
  if (query.projectScope) {
    values.push(query.projectScope);
    conditions.push(`project_id = $${values.length}`);
  }
  values.push(limit);

  const sql = `
    SELECT
      correlation_id,
      count(*) FILTER (WHERE decision <> 'external')::text AS requests,
      count(*) FILTER (WHERE decision = 'external')::text AS external_events,
      coalesce(sum(actual_cost_usd), 0)::text AS actual_cost,
      coalesce(sum(actual_cost_usd) FILTER (WHERE decision <> 'external'), 0)::text AS llm_actual_cost,
      coalesce(sum(actual_cost_usd) FILTER (WHERE decision = 'external'), 0)::text AS external_actual_cost,
      coalesce(sum(estimated_cost_usd), 0)::text AS estimated_cost,
      min(created_at) AS first_seen,
      max(created_at) AS last_seen
    FROM request_logs
    WHERE ${conditions.join(" AND ")}
    GROUP BY correlation_id
    ORDER BY coalesce(NULLIF(sum(actual_cost_usd), 0), sum(estimated_cost_usd), 0) DESC, max(created_at) DESC
    LIMIT $${values.length}
  `;

  const { rows } = await pool.query<RollupRow>(sql, values);
  return {
    since: since.toISOString(),
    limit,
    transactions: rows.map((r) => ({
      correlationId: r.correlation_id,
      requests: Number(r.requests),
      externalEvents: Number(r.external_events),
      actualCostUsd: Number(r.actual_cost),
      llmCostUsd: Number(r.llm_actual_cost),
      externalCostUsd: Number(r.external_actual_cost),
      estimatedCostUsd: Number(r.estimated_cost),
      firstSeen: r.first_seen.toISOString(),
      lastSeen: r.last_seen.toISOString(),
    })),
  };
}
