import type { Pool } from "pg";

export interface RequestLogRow {
  projectId?: string;
  environment?: string;
  userId: string;
  userType: string;
  feature: string;
  modelClass?: string;
  requestedModelClass?: string;
  resolvedModel?: string;
  decision: string;
  status: "ok" | "failed" | "safety_blocked";
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  piiMasked?: boolean;
  injectionBlocked?: boolean;
  error?: string;
  reasonCode?: string;
  traceTags?: unknown;
  safetyFindings?: unknown;
  /** Host-app metadata from the chat request (non-authoritative). */
  hostMetadata?: Record<string, unknown>;
  /** SHA-256 of the effective config that produced this decision. */
  configHash?: string;
  /** config_versions id when the policy store is on, else "file". */
  policyVersion?: string;
}

export function formatAuditRequestId(id: number): string {
  return `req_${id}`;
}

const LOG_SQL = `
  INSERT INTO request_logs (
    project_id, environment, user_id, user_type, feature, model_class,
    requested_model_class, resolved_model, decision, status, estimated_cost_usd,
    actual_cost_usd, input_tokens, output_tokens, pii_masked, injection_blocked,
    error, reason_code, trace_tags, safety_findings, host_metadata,
    config_hash, policy_version
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
  )
  RETURNING id
`;

const RETENTION_SQL = `
  DELETE FROM request_logs
  WHERE id IN (
    SELECT id FROM request_logs WHERE created_at < $1::timestamptz LIMIT $2
  )
`;

/**
 * Prune audit rows older than the retention window, in bounded batches so a
 * large backlog doesn't hold a long lock. Returns the total number removed.
 */
export async function cleanupOldRequestLogs(
  pool: Pool,
  retentionMs: number,
  now = Date.now(),
  batchSize = 5000,
): Promise<number> {
  const cutoff = new Date(now - retentionMs).toISOString();
  let total = 0;
  for (;;) {
    const res = await pool.query(RETENTION_SQL, [cutoff, batchSize]);
    const removed = res.rowCount ?? 0;
    total += removed;
    if (removed < batchSize) break;
  }
  return total;
}

const FEATURE_RETENTION_SQL = `
  DELETE FROM request_logs
  WHERE id IN (
    SELECT id FROM request_logs
    WHERE feature = $1 AND created_at < $2::timestamptz
    ORDER BY id
    LIMIT $3
  )
`;

/** Prune one feature's request_logs older than its own retention window. */
export async function cleanupOldRequestLogsForFeature(
  pool: Pool,
  feature: string,
  retentionMs: number,
  now = Date.now(),
  batchSize = 5000,
): Promise<number> {
  const cutoff = new Date(now - retentionMs).toISOString();
  let total = 0;
  for (;;) {
    const res = await pool.query(FEATURE_RETENTION_SQL, [feature, cutoff, batchSize]);
    const removed = res.rowCount ?? 0;
    total += removed;
    if (removed < batchSize) break;
  }
  return total;
}

const RECENT_STATS_SQL = `
  SELECT
    count(*)::text AS total,
    count(*) FILTER (WHERE status <> 'ok')::text AS failed
  FROM request_logs
  WHERE created_at >= $1::timestamptz
`;

const RECENT_STATS_SQL_SCOPED = `
  SELECT
    count(*)::text AS total,
    count(*) FILTER (WHERE status <> 'ok')::text AS failed
  FROM request_logs
  WHERE created_at >= $1::timestamptz
    AND project_id = $2
`;

/**
 * Count request_logs rows (total and failed) since `since`, optionally scoped to
 * a project partition. Powers the operator usage summary.
 */
export async function getRecentRequestStats(
  pool: Pool,
  since: Date,
  projectId?: string,
): Promise<{ total: number; failed: number }> {
  const { rows } = await pool.query<{ total: string; failed: string }>(
    projectId ? RECENT_STATS_SQL_SCOPED : RECENT_STATS_SQL,
    projectId ? [since.toISOString(), projectId] : [since.toISOString()],
  );
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}

/** Append an audit-log row. Returns `req_<id>` when inserted; null on failure. */
export async function logRequest(pool: Pool, row: RequestLogRow): Promise<string | null> {
  try {
    const res = await pool.query<{ id: string }>(LOG_SQL, [
      row.projectId ?? null,
      row.environment ?? null,
      row.userId,
      row.userType,
      row.feature,
      row.modelClass ?? null,
      row.requestedModelClass ?? null,
      row.resolvedModel ?? null,
      row.decision,
      row.status,
      row.estimatedCostUsd ?? null,
      row.actualCostUsd ?? null,
      row.inputTokens ?? null,
      row.outputTokens ?? null,
      row.piiMasked ?? null,
      row.injectionBlocked ?? null,
      row.error ?? null,
      row.reasonCode ?? null,
      row.traceTags != null ? JSON.stringify(row.traceTags) : null,
      row.safetyFindings != null ? JSON.stringify(row.safetyFindings) : null,
      row.hostMetadata != null ? JSON.stringify(row.hostMetadata) : null,
      row.configHash ?? null,
      row.policyVersion ?? null,
    ]);
    const id = res.rows[0]?.id;
    return id ? formatAuditRequestId(Number(id)) : null;
  } catch {
    return null;
  }
}
