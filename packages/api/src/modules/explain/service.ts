import {
  evaluateAiRequest,
  PolicyConfigError,
  type ModelgovConfig,
  type AiRequest,
} from "@modelgov/policy-engine";
import type { Pool } from "pg";
import { loadUsageSnapshot } from "../usage/repo";
import { formatExplainSummary, wouldCallModel } from "./format";
import type { ExplainInput, ExplainResponse } from "./types";
import { usageSnapshotToUsed } from "./types";

export async function handleExplain(
  config: ModelgovConfig,
  pool: Pool,
  body: ExplainInput,
  tenantId?: string,
): Promise<ExplainResponse | PolicyConfigError> {
  const aiRequest: AiRequest = {
    projectId: body.projectId ?? config.project.name,
    environment: body.environment ?? config.project.environment,
    userId: body.userId,
    userType: body.userType,
    feature: body.feature,
    requestedModelClass: body.modelClass,
    inputTokensEstimate: body.inputTokensEstimate,
  };

  const feature = config.features[body.feature];
  const userBudget = config.budgets.byUserType[body.userType];
  const requestedModelClass = body.modelClass ?? feature?.modelClass ?? "";

  const now = new Date();
  const usage = await loadUsageSnapshot(pool, {
    projectId: aiRequest.projectId,
    userId: aiRequest.userId,
    feature: aiRequest.feature,
    now,
    tenantId,
  });

  let decision;
  try {
    decision = evaluateAiRequest({ request: aiRequest, config, usage });
  } catch (err) {
    if (err instanceof PolicyConfigError) return err;
    throw err;
  }

  const dailyRequestsRemaining = Math.max(
    0,
    (userBudget?.dailyRequests ?? 0) - usage.userDailyRequestsUsed,
  );

  const response: ExplainResponse = {
    decision: decision.decision,
    reason: decision.reason,
    requested: {
      userId: body.userId,
      userType: body.userType,
      feature: body.feature,
      modelClass: requestedModelClass,
    },
    resolved: {
      modelClass: decision.resolvedModelClass,
      model: decision.resolvedModel,
      provider: decision.resolvedProvider,
      fallbackModel: decision.fallbackModel,
    },
    safety: {
      preset: decision.safetyPreset,
      pii: decision.safetyPlan.pii,
      promptInjection: decision.safetyPlan.promptInjection,
      maxOutputTokens: decision.maxOutputTokens,
    },
    reasonCode: decision.reasonCode,
    cost: {
      estimatedUsd: decision.estimatedCostUsd,
    },
    budget: {
      remaining: decision.budgetRemaining,
      used: usageSnapshotToUsed(usage),
      permittedModels: userBudget?.models ?? [],
      dailyRequestLimit: userBudget?.dailyRequests ?? 0,
      dailyRequestsRemaining,
    },
    wouldCallModel: wouldCallModel(decision.decision),
    summary: "",
  };

  response.summary = formatExplainSummary(response);
  return response;
}
