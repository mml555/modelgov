import type { Pool } from "pg";
import { dayWindowStart, monthWindowStart } from "../../services/windows";
import { getRecentRequestStats } from "./auditLogRepo";
import type { AuthorizedUsageQuery } from "./authorizeUsage";
import { loadUsageSnapshot } from "./repo";

/**
 * The raw query as parsed off the request. The project partition, projectScope,
 * and includeGlobal are resolved by `authorizeUsageQuery` into an
 * AuthorizedUsageQuery — those fields are NOT part of the raw input, so they are
 * not repeated here (that avoided a second, divergent 'default' fallback).
 */
export interface UsageQuery {
  userId?: string;
  feature?: string;
  /** Ops keys may target a specific project partition (defaults to deployment project). */
  projectId?: string;
}

export interface UsageSummary {
  asOf: string;
  projectId?: string;
  userDaily?: {
    userId: string;
    windowStart: string;
    usedUsd: number;
    reservedUsd: number;
    requestsUsed: number;
  };
  featureMonthly?: {
    feature: string;
    windowStart: string;
    usedUsd: number;
    reservedUsd: number;
  };
  globalMonthly?: {
    windowStart: string;
    usedUsd: number;
    reservedUsd: number;
  };
  recentRequests: {
    last24h: number;
    last24hFailed: number;
  };
}

export async function getUsageSummary(
  pool: Pool,
  query: AuthorizedUsageQuery,
  now = new Date(),
): Promise<UsageSummary> {
  const month = monthWindowStart(now);
  // Trust the authorized values. authorizeUsageQuery already resolved the
  // project partition (ctx.projectId ?? query.projectId ?? defaultProjectId) —
  // the same default the writer (reserveBudget) uses. Re-deriving here with a
  // hardcoded 'default' fallback risked reading a different partition than the
  // one chat requests wrote under.
  const budgetProjectId = query.budgetProjectId;
  const includeGlobal = query.includeGlobal;
  const globalSnap = includeGlobal
    ? await loadUsageSnapshot(pool, {
        projectId: budgetProjectId,
        userId: query.userId ?? "_none_",
        feature: query.feature ?? "_none_",
        now,
        tenantId: query.tenantScope,
      })
    : null;

  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const recent = await getRecentRequestStats(pool, dayAgo, {
    projectId: query.projectScope,
    tenantId: query.tenantScope,
  });
  const summary: UsageSummary = {
    asOf: now.toISOString(),
    projectId: budgetProjectId,
    recentRequests: { last24h: recent.total, last24hFailed: recent.failed },
  };

  if (includeGlobal && globalSnap) {
    summary.globalMonthly = {
      windowStart: month,
      usedUsd: globalSnap.globalMonthlyUsdUsed,
      reservedUsd: globalSnap.globalMonthlyUsdReserved,
    };
  }

  if (query.userId) {
    const day = dayWindowStart(now);
    const snap = await loadUsageSnapshot(pool, {
      projectId: budgetProjectId,
      userId: query.userId,
      feature: query.feature ?? "_any_",
      now,
      tenantId: query.tenantScope,
    });
    summary.userDaily = {
      userId: query.userId,
      windowStart: day,
      usedUsd: snap.userDailyUsdUsed,
      reservedUsd: snap.userDailyUsdReserved,
      requestsUsed: snap.userDailyRequestsUsed,
    };
  }

  if (query.feature) {
    const snap = await loadUsageSnapshot(pool, {
      projectId: budgetProjectId,
      userId: query.userId ?? "_any_",
      feature: query.feature,
      now,
      tenantId: query.tenantScope,
    });
    summary.featureMonthly = {
      feature: query.feature,
      windowStart: month,
      usedUsd: snap.featureMonthlyUsdUsed,
      reservedUsd: snap.featureMonthlyUsdReserved,
    };
  }

  return summary;
}
