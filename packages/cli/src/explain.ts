import { readFileSync } from "node:fs";
import {
  evaluateAiRequest,
  parseConfig,
  PolicyConfigError,
  type AiGuardConfig,
  type UsageSnapshot,
} from "@ai-guard/policy-engine";
import { resolveUserPath } from "./paths.js";

export interface ExplainFlags {
  userId: string;
  userType?: string;
  feature?: string;
  modelClass?: string;
  inputTokensEstimate?: number;
  configPath: string;
  local: boolean;
  baseUrl: string;
  apiKey?: string;
  json: boolean;
}

export function loadConfigFromPath(path: string): AiGuardConfig {
  const text = readFileSync(resolveUserPath(path), "utf8");
  return parseConfig(text);
}

export function explainLocally(
  config: AiGuardConfig,
  flags: ExplainFlags,
  usage: UsageSnapshot = emptyUsage(),
): Record<string, unknown> {
  const feature = config.features[flags.feature!];
  const userBudget = config.budgets.byUserType[flags.userType!];
  const requestedFeature = flags.feature!;
  const requestedUserType = flags.userType!;
  const requestedModelClass = flags.modelClass ?? feature?.modelClass ?? "";

  try {
    const decision = evaluateAiRequest({
      request: {
        projectId: config.project.name,
        environment: config.project.environment,
        userId: flags.userId,
        userType: requestedUserType,
        feature: requestedFeature,
        requestedModelClass: flags.modelClass,
        inputTokensEstimate: flags.inputTokensEstimate,
      },
      config,
      usage,
    });

    const dailyRequestsRemaining = Math.max(
      0,
      (userBudget?.dailyRequests ?? 0) - usage.userDailyRequestsUsed,
    );

    const body = {
      decision: decision.decision,
      reason: decision.reason,
      requested: {
        userId: flags.userId,
        userType: requestedUserType,
        feature: requestedFeature,
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
      cost: { estimatedUsd: decision.estimatedCostUsd },
      budget: {
        remaining: decision.budgetRemaining,
        used: {
          userDailyUsd: usage.userDailyUsdUsed + usage.userDailyUsdReserved,
          userDailyRequests: usage.userDailyRequestsUsed,
          featureMonthlyUsd: usage.featureMonthlyUsdUsed + usage.featureMonthlyUsdReserved,
          globalMonthlyUsd: usage.globalMonthlyUsdUsed + usage.globalMonthlyUsdReserved,
        },
        permittedModels: userBudget?.models ?? [],
        dailyRequestLimit: userBudget?.dailyRequests ?? 0,
        dailyRequestsRemaining,
      },
      wouldCallModel: decision.decision !== "block",
      summary: "",
    };

    body.summary = formatSummary(body);
    return body;
  } catch (err) {
    if (err instanceof PolicyConfigError) {
      throw new Error(`${err.code}: ${err.message}`);
    }
    throw err;
  }
}

export async function runExplain(flags: ExplainFlags): Promise<void> {
  if (flags.local) {
    const config = loadConfigFromPath(flags.configPath);
    const body = explainLocally(config, flags);
    print(body, flags.json);
    return;
  }

  if (!flags.apiKey) {
    throw new Error(
      "AI_GUARD_API_KEY is required for API mode. Use --local to evaluate a config file offline.",
    );
  }

  const baseUrl = flags.baseUrl.replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/v1/explain`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${flags.apiKey}`,
    },
    body: JSON.stringify({
      userId: flags.userId,
      userType: flags.userType,
      feature: flags.feature,
      modelClass: flags.modelClass,
      inputTokensEstimate: flags.inputTokensEstimate,
    }),
  });

  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = body.error as { message?: string; code?: string } | undefined;
    throw new Error(err?.message ?? `explain failed (${res.status})`);
  }

  print(body, flags.json);
}

function emptyUsage(): UsageSnapshot {
  return {
    userDailyUsdUsed: 0,
    userDailyUsdReserved: 0,
    userDailyRequestsUsed: 0,
    featureMonthlyUsdUsed: 0,
    featureMonthlyUsdReserved: 0,
    globalMonthlyUsdUsed: 0,
    globalMonthlyUsdReserved: 0,
  };
}

function formatSummary(body: {
  decision: string;
  reason?: string;
  requested: { modelClass: string; feature: string; userType: string };
  resolved: { modelClass: string; model: string; fallbackModel?: string };
  safety: { preset: string; pii: string; promptInjection: string };
  cost: { estimatedUsd: number };
  budget: {
    remaining: { userDailyUsd: number };
    dailyRequestsRemaining: number;
    dailyRequestLimit: number;
  };
  wouldCallModel: boolean;
}): string {
  const lines = [`Decision: ${body.decision}`];
  if (body.reason) lines.push(`Reason: ${body.reason}`);
  lines.push(
    `Requested: ${body.requested.modelClass} (${body.requested.feature} / ${body.requested.userType})`,
  );
  if (body.requested.modelClass !== body.resolved.modelClass) {
    lines.push(`Resolved class: ${body.resolved.modelClass}`);
  }
  lines.push(`Model: ${body.resolved.model}`);
  if (body.resolved.fallbackModel) lines.push(`Fallback: ${body.resolved.fallbackModel}`);
  lines.push(
    `Budget remaining: $${body.budget.remaining.userDailyUsd.toFixed(4)} today` +
      ` (${body.budget.dailyRequestsRemaining}/${body.budget.dailyRequestLimit} requests)`,
  );
  lines.push(
    `Safety: ${body.safety.preset} (pii: ${body.safety.pii}, injection: ${body.safety.promptInjection})`,
  );
  lines.push(`Est. cost: $${body.cost.estimatedUsd.toFixed(6)}`);
  lines.push(
    body.wouldCallModel
      ? "→ Request would proceed to the model."
      : "→ Request would be blocked before calling the model.",
  );
  return lines.join("\n");
}

function print(body: Record<string, unknown>, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const summary = body.summary;
  if (typeof summary === "string" && summary.length > 0) {
    console.log(summary);
    return;
  }
  console.log(JSON.stringify(body, null, 2));
}
