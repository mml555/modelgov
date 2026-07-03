import type { BudgetRemaining, PolicyDecisionKind, UsageSnapshot } from "@modelgov/policy-engine";

export interface ExplainInput {
  userId: string;
  userType: string;
  feature: string;
  modelClass?: string;
  inputTokensEstimate?: number;
  projectId?: string;
  environment?: string;
}

export interface ExplainResponse {
  decision: PolicyDecisionKind;
  reason?: string;
  reasonCode?: string;
  requested: {
    userId: string;
    userType: string;
    feature: string;
    modelClass: string;
  };
  resolved: {
    modelClass: string;
    model: string;
    provider: string;
    fallbackModel?: string;
  };
  safety: {
    preset: string;
    pii: string;
    promptInjection: string;
    maxOutputTokens: number;
  };
  cost: {
    estimatedUsd: number;
  };
  budget: {
    remaining: BudgetRemaining;
    used: {
      userDailyUsd: number;
      userDailyRequests: number;
      featureMonthlyUsd: number;
      globalMonthlyUsd: number;
    };
    permittedModels: string[];
    dailyRequestLimit: number;
    dailyRequestsRemaining: number;
  };
  wouldCallModel: boolean;
  summary: string;
}

export interface ExplainServiceDeps {
  config: import("@modelgov/policy-engine").ModelgovConfig;
  pool: import("pg").Pool;
}

export function usageSnapshotToUsed(usage: UsageSnapshot): ExplainResponse["budget"]["used"] {
  return {
    userDailyUsd: usage.userDailyUsdUsed + usage.userDailyUsdReserved,
    userDailyRequests: usage.userDailyRequestsUsed,
    featureMonthlyUsd: usage.featureMonthlyUsdUsed + usage.featureMonthlyUsdReserved,
    globalMonthlyUsd: usage.globalMonthlyUsdUsed + usage.globalMonthlyUsdReserved,
  };
}
