import { apiFetch } from "./client";

/** GET /v1/usage/summary — aggregated request/cost outcomes over a window. */
export interface UsageSummary {
  since: string;
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

/** GET /v1/usage — current budget counters (global month spend vs cap). */
export interface BudgetCounters {
  asOf: string;
  globalMonthly?: {
    windowStart: string;
    usedUsd: number;
    reservedUsd: number;
    capUsd?: number;
  };
  recentRequests: { last24h: number; last24hFailed: number };
}

/** One row of GET /v1/usage/transactions — cost for a single business transaction. */
export interface Transaction {
  correlationId: string;
  requests: number;
  externalEvents: number;
  actualCostUsd: number;
  llmCostUsd: number;
  externalCostUsd: number;
  estimatedCostUsd: number;
  firstSeen: string;
  lastSeen: string;
}

export interface TransactionRollup {
  since: string;
  limit: number;
  transactions: Transaction[];
}

export const fetchUsageSummary = (since: string): Promise<UsageSummary> =>
  apiFetch<UsageSummary>(`/v1/usage/summary?since=${encodeURIComponent(since)}`);

export const fetchBudgetCounters = (): Promise<BudgetCounters> =>
  apiFetch<BudgetCounters>("/v1/usage");

export const fetchTransactions = (since: string, limit = 50): Promise<TransactionRollup> =>
  apiFetch<TransactionRollup>(
    `/v1/usage/transactions?since=${encodeURIComponent(since)}&limit=${limit}`,
  );
