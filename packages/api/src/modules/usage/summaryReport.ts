import type { Pool } from "pg";
import {
  getTopModelUsed,
  getTopReasonCode,
  getUsageAggregate,
  type UsageSummaryFilters,
} from "./summaryReportRepo";

export interface UsageSummaryQuery {
  feature?: string;
  userType?: string;
  since?: string;
  projectScope?: string;
  tenantScope?: string;
}

export interface UsageSummaryReport {
  since: string;
  feature?: string;
  userType?: string;
  requests: number;
  completed: number;
  blocked: number;
  degraded: number;
  fallbacks: number;
  safetyBlocked: number;
  actualCostUsd: number;
  estimatedCostUsd: number;
  topReasonCode?: { code: string; count: number };
  topModel?: { model: string; count: number };
}

export async function getUsageSummaryReport(
  pool: Pool,
  query: UsageSummaryQuery,
): Promise<UsageSummaryReport> {
  const sinceDate = parseSince(query.since ?? "24h");
  const filters: UsageSummaryFilters = {
    since: sinceDate,
    projectScope: query.projectScope,
    tenantScope: query.tenantScope,
    feature: query.feature,
    userType: query.userType,
  };
  const agg = await getUsageAggregate(pool, filters);
  const topReason = await mapTopReasonCode(pool, filters);
  const topModel = await mapTopModel(pool, filters);

  return {
    since: sinceDate.toISOString(),
    feature: query.feature,
    userType: query.userType,
    requests: Number(agg?.requests ?? 0),
    completed: Number(agg?.completed ?? 0),
    blocked: Number(agg?.blocked ?? 0),
    degraded: Number(agg?.degraded ?? 0),
    fallbacks: Number(agg?.fallbacks ?? 0),
    safetyBlocked: Number(agg?.safety_blocked ?? 0),
    actualCostUsd: Number(agg?.actual_cost ?? 0),
    estimatedCostUsd: Number(agg?.estimated_cost ?? 0),
    topReasonCode: topReason,
    topModel,
  };
}

async function mapTopReasonCode(pool: Pool, filters: UsageSummaryFilters) {
  const row = await getTopReasonCode(pool, filters);
  if (!row || row.code === "unknown") return undefined;
  return { code: row.code, count: Number(row.count) };
}

async function mapTopModel(pool: Pool, filters: UsageSummaryFilters) {
  const row = await getTopModelUsed(pool, filters);
  return row ? { model: row.model, count: Number(row.count) } : undefined;
}

function parseSince(raw: string): Date {
  const now = Date.now();
  const match = /^(\d+)(h|d)$/.exec(raw.trim());
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    const ms = unit === "h" ? amount * 60 * 60 * 1000 : amount * 24 * 60 * 60 * 1000;
    return new Date(now - ms);
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return new Date(parsed);
  throw new Error("invalid_since");
}
