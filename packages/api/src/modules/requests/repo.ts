import type { Pool } from "pg";
import { appendRequestLogTenantScope } from "../../db/requestLogScope";
import { parseSince } from "../../util/timeWindow";
import { apiStatusToDbStatus, inferReasonCode, mapDbStatus, providerFromModel } from "./reasonCode";
import type { RequestListQuery, RequestRecord } from "./types";

interface RequestLogDbRow {
  id: string;
  created_at: Date;
  project_id: string | null;
  environment: string | null;
  user_id: string | null;
  user_type: string | null;
  feature: string;
  model_class: string | null;
  requested_model_class: string | null;
  resolved_model: string | null;
  decision: string;
  status: string;
  estimated_cost_usd: string | null;
  actual_cost_usd: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  pii_masked: boolean | null;
  injection_blocked: boolean | null;
  error: string | null;
  reason_code: string | null;
  host_metadata: Record<string, unknown> | null;
  config_hash: string | null;
  policy_version: string | null;
  correlation_id: string | null;
}

const SELECT_FIELDS = `
  id, created_at, project_id, environment, user_id, user_type, feature,
  model_class, requested_model_class, resolved_model, decision, status,
  estimated_cost_usd, actual_cost_usd, input_tokens, output_tokens,
  pii_masked, injection_blocked,   error, reason_code, host_metadata,
  config_hash, policy_version, correlation_id
`;

export function parseRequestId(raw: string): number {
  const trimmed = raw.trim();
  const id = trimmed.startsWith("req_") ? trimmed.slice(4) : trimmed;
  const num = Number(id);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error("invalid_request_id");
  }
  return num;
}

export function formatRequestId(id: number | string): string {
  return `req_${id}`;
}

export function rowToRecord(row: RequestLogDbRow): RequestRecord {
  const reasonCode = row.reason_code ?? inferReasonCode(row.error, row.decision);
  const piiMasked = row.pii_masked === true;
  const injectionBlocked = row.injection_blocked === true;

  return {
    id: formatRequestId(row.id),
    status: mapDbStatus(row.status, row.decision),
    decision: row.decision,
    reasonCode,
    reason: row.error ?? undefined,
    feature: row.feature,
    userType: row.user_type ?? undefined,
    userId: row.user_id ?? undefined,
    projectId: row.project_id ?? undefined,
    environment: row.environment ?? undefined,
    requestedModelClass: row.requested_model_class ?? undefined,
    resolvedModelClass: row.model_class ?? undefined,
    provider: providerFromModel(row.resolved_model),
    model: row.resolved_model ?? undefined,
    estimatedCostUsd: row.estimated_cost_usd != null ? Number(row.estimated_cost_usd) : undefined,
    actualCostUsd: row.actual_cost_usd != null ? Number(row.actual_cost_usd) : undefined,
    inputTokens: row.input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    safety: {
      pii: piiMasked ? "masked" : reasonCode === "pii_blocked" ? "blocked" : "none",
      promptInjection: injectionBlocked || reasonCode === "prompt_injection_blocked"
        ? "blocked"
        : "passed",
    },
    timestamps: {
      createdAt: row.created_at.toISOString(),
    },
    correlationId: row.correlation_id ?? undefined,
    metadata: row.host_metadata ?? undefined,
    policy: {
      configHash: row.config_hash ?? undefined,
      policyVersion: row.policy_version ?? undefined,
    },
  };
}

export async function getRequestById(
  pool: Pool,
  id: number,
  scope?: { projectScope?: string; tenantScope?: string },
): Promise<RequestRecord | null> {
  const conditions = ["id = $1"];
  const values: unknown[] = [id];
  appendRequestLogTenantScope(conditions, values, scope?.tenantScope);
  if (scope?.projectScope) {
    values.push(scope.projectScope);
    conditions.push(`project_id = $${values.length}`);
  }
  const { rows } = await pool.query<RequestLogDbRow>(
    `SELECT ${SELECT_FIELDS} FROM request_logs WHERE ${conditions.join(" AND ")}`,
    values,
  );
  const row = rows[0];
  return row ? rowToRecord(row) : null;
}

export interface ListRequestsParams extends RequestListQuery {
  projectScope?: string;
  tenantScope?: string;
}

export async function listRequests(
  pool: Pool,
  params: ListRequestsParams,
): Promise<RequestRecord[]> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const conditions: string[] = [];
  const values: unknown[] = [];

  appendRequestLogTenantScope(conditions, values, params.tenantScope);
  if (params.projectScope) {
    values.push(params.projectScope);
    conditions.push(`project_id = $${values.length}`);
  }
  if (params.userId) {
    values.push(params.userId);
    conditions.push(`user_id = $${values.length}`);
  }
  if (params.feature) {
    values.push(params.feature);
    conditions.push(`feature = $${values.length}`);
  }
  if (params.userType) {
    values.push(params.userType);
    conditions.push(`user_type = $${values.length}`);
  }
  if (params.reasonCode) {
    values.push(params.reasonCode);
    conditions.push(`reason_code = $${values.length}`);
  }
  if (params.correlationId) {
    values.push(params.correlationId);
    conditions.push(`correlation_id = $${values.length}`);
  } else {
    // Externally-ingested cost rows (decision='external') are not LLM requests;
    // exclude them from the default list so they don't masquerade as 'completed'
    // requests (parity with /v1/usage/summary). They remain visible when drilling
    // into a specific transaction via correlationId, where the line items matter.
    conditions.push("decision <> 'external'");
  }
  if (params.status) {
    const dbStatuses = apiStatusToDbStatus(params.status);
    if (dbStatuses.length > 0) {
      values.push(dbStatuses);
      conditions.push(`status = ANY($${values.length}::text[])`);
    }
  }
  if (params.since) {
    const sinceDate = parseSince(params.since);
    values.push(sinceDate.toISOString());
    conditions.push(`created_at >= $${values.length}::timestamptz`);
  }

  values.push(limit);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT ${SELECT_FIELDS}
    FROM request_logs
    ${where}
    ORDER BY created_at DESC
    LIMIT $${values.length}
  `;

  const { rows } = await pool.query<RequestLogDbRow>(sql, values);
  return rows.map(rowToRecord);
}
