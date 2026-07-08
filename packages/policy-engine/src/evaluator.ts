import { estimateCostUsd, estimateTokens, roundUsd } from "./cost";
import {
  nextPermittedCheaperClass,
  providerOf,
  resolveModelInfo,
} from "./routing";
import { resolveSafetyPlan } from "./safety";
import {
  PolicyConfigError,
  type ModelgovConfig,
  type BudgetRemaining,
  type EvaluateInput,
  type FeatureConfig,
  type GlobalBudget,
  type PolicyDecision,
  type PolicyDecisionKind,
  type ReservationCaps,
  type SafetyPlan,
  type UsageSnapshot,
  type UserTypeBudget,
} from "./types";

/**
 * Worst-case USD estimate for a model, honoring subscription billing. Models on
 * a registry subscription provider (e.g. Copilot) are already zeroed inside
 * `getModelPrice`; this additionally zeroes a model whose provider an operator
 * marked `billing: subscription` in `providers:` (custom/self-hosted gateways),
 * so USD is not reserved for it — token/request budgets still enforce.
 */
function estimateForModel(
  config: ModelgovConfig,
  model: string,
  inputTokensEstimate: number | undefined,
  outputTokensForEstimate: number,
): number {
  // A config-level `billing: subscription` provider reserves $0 USD — UNLESS the
  // operator also set an explicit `pricing` override for the model, which wins
  // (matching getModelPrice's override-first precedence, so a deliberately
  // priced subscription model still enforces its USD budgets). Registry-based
  // subscription providers (e.g. github_copilot) need no branch here:
  // estimateCostUsd → getModelPrice already applies override → subscription-zero.
  const hasPricingOverride = config.pricing?.[model] !== undefined;
  if (!hasPricingOverride && config.providers[providerOf(model)]?.billing === "subscription") {
    return 0;
  }
  return estimateCostUsd(model, inputTokensEstimate, outputTokensForEstimate, config.pricing);
}

/**
 * The core IP. Pure and deterministic — no I/O, no clock, no randomness. Given
 * the request, the parsed config, and a usage snapshot (used + reserved), it
 * decides whether the call is allowed and which model/safety policy applies.
 *
 * Throws PolicyConfigError for contract violations (unknown feature / model
 * class / user type) — the API maps those to HTTP 400. Policy *outcomes*
 * (allow / block / degrade / fallback) are returned, never thrown.
 */
export function evaluateAiRequest(input: EvaluateInput): PolicyDecision {
  const { request, config, usage } = input;

  const feature = config.features[request.feature];
  if (!feature) {
    throw new PolicyConfigError(
      `unknown feature: '${request.feature}'`,
      "unknown_feature",
    );
  }

  const userBudget = config.budgets.byUserType[request.userType];
  if (!userBudget) {
    throw new PolicyConfigError(
      `unknown user_type: '${request.userType}'`,
      "unknown_user_type",
    );
  }

  const requestedClass = request.requestedModelClass ?? feature.modelClass;
  if (!config.modelClasses[requestedClass]) {
    throw new PolicyConfigError(
      `unknown model_class: '${requestedClass}'`,
      "unknown_model_class",
    );
  }

  const safetyPlan = resolveSafetyPlan(config, feature);
  // Output tokens used for the worst-case estimate. `?? ` (not `||`) so an
  // explicit 0 from embeddings zeroes the completion term instead of falling
  // back to the feature's maxOutputTokens.
  const outputTokensForEstimate =
    request.outputTokensEstimate ?? safetyPlan.maxOutputTokens;
  const ctx: BuildCtx = {
    config,
    feature,
    userBudget,
    usage,
    safetyPlan,
    outputTokensForEstimate,
    userId: request.userId,
    featureName: request.feature,
    inputTokensEstimate: request.inputTokensEstimate,
  };

  // ── Permitted-class check ────────────────────────────────────────────────
  // (Skipped on fallback re-eval: the request was already approved.)
  if (!request.forceFallback && !userBudget.models.includes(requestedClass)) {
    return buildDecision(ctx, {
      decision: "block",
      reasonCode: "model_class_not_permitted",
      reason: `model_class '${requestedClass}' is not permitted for user_type '${request.userType}'`,
      effectiveClass: requestedClass,
      useFallback: false,
    });
  }

  // ── Budget-aware degrade ───────────────────────────────────────────────────
  // Runs on the fallback re-eval too (NOT gated on !forceFallback): a request
  // degraded for budget reasons must stay degraded when it falls back, so the
  // fallback resolves the *degraded* class's fallback model rather than the
  // original (more expensive) class's. The usage snapshot is unchanged between
  // the two evals, so this re-derives the same degraded class deterministically.
  let effectiveClass = requestedClass;
  let degraded = false;
  const global = config.budgets.global;
  const globalSpend = usage.globalMonthlyUsdUsed + usage.globalMonthlyUsdReserved;
  if (global.monthlyUsd > 0) {
    const degradeThreshold = global.monthlyUsd * (config.routing.degradeAtPercent / 100);
    if (globalSpend >= degradeThreshold) {
      const cheaper = nextPermittedCheaperClass(
        effectiveClass,
        userBudget.models,
        config,
      );
      if (cheaper) {
        effectiveClass = cheaper;
        degraded = true;
      }
    }
  }

  // ── Fallback path (post provider-failure re-eval) ──────────────────────────
  // Resolve the fallback model for the (possibly degraded) class and return
  // without re-running budget gates — the request is already in flight. The
  // data-sensitivity gate still applies: the fallback provider must be approved
  // for the feature's data class.
  if (request.forceFallback) {
    const fbInfo = resolveModelInfo(config, effectiveClass, true);
    const sensitivityViolation = checkDataSensitivity(
      config,
      feature,
      effectiveClass,
      fbInfo.provider,
    );
    if (sensitivityViolation) {
      return buildDecision(ctx, {
        decision: "block",
        reasonCode: "data_sensitivity_not_permitted",
        reason: sensitivityViolation,
        effectiveClass,
        useFallback: false,
      });
    }
    return buildDecision(ctx, {
      decision: "fallback",
      reasonCode: "provider_fallback",
      reason: "provider failure on primary — routed to fallback model",
      effectiveClass,
      useFallback: true,
    });
  }

  // ── Data-sensitivity gate ──────────────────────────────────────────────────
  // The resolved (possibly degraded) model class and its provider must be
  // approved for the feature's data-sensitivity class. Runs before budget gates
  // so a restricted-data request can't route to an unapproved model even if it
  // has budget.
  const { model, provider } = resolveModelInfo(config, effectiveClass, false);
  const sensitivityViolation = checkDataSensitivity(
    config,
    feature,
    effectiveClass,
    provider,
  );
  if (sensitivityViolation) {
    return buildDecision(ctx, {
      decision: "block",
      reasonCode: "data_sensitivity_not_permitted",
      reason: sensitivityViolation,
      effectiveClass,
      useFallback: false,
    });
  }

  // ── Budget gates (block on any breach) ─────────────────────────────────────
  const estimate = estimateForModel(
    config,
    model,
    request.inputTokensEstimate,
    outputTokensForEstimate,
  );

  if (usage.userDailyRequestsUsed + 1 > userBudget.dailyRequests) {
    return buildDecision(ctx, {
      decision: "block",
      reasonCode: "daily_request_limit_reached",
      reason: `daily request limit reached (${userBudget.dailyRequests})`,
      effectiveClass,
      useFallback: false,
    });
  }

  const userDailySpend = usage.userDailyUsdUsed + usage.userDailyUsdReserved;
  if (userDailySpend + estimate > userBudget.dailyUsd) {
    return buildDecision(ctx, {
      decision: "block",
      reasonCode: "daily_budget_exceeded",
      reason: `user daily budget exceeded (cap $${userBudget.dailyUsd})`,
      effectiveClass,
      useFallback: false,
    });
  }

  const featureCap = feature.budget?.monthlyUsd ?? null;
  const featureSpend =
    usage.featureMonthlyUsdUsed + usage.featureMonthlyUsdReserved;
  if (featureCap !== null && featureSpend + estimate > featureCap) {
    return buildDecision(ctx, {
      decision: "block",
      reasonCode: "feature_monthly_budget_exceeded",
      reason: `feature monthly budget exceeded (cap $${featureCap})`,
      effectiveClass,
      useFallback: false,
    });
  }

  if (global.monthlyUsd > 0) {
    const hardStop = global.monthlyUsd * (global.hardStopAtPercent / 100);
    if (globalSpend + estimate > hardStop) {
      return buildDecision(ctx, {
        decision: "block",
        reasonCode: "global_monthly_budget_exceeded",
        reason: `global monthly budget hard stop reached (cap $${hardStop})`,
        effectiveClass,
        useFallback: false,
      });
    }
  }

  const globalDailyCap = global.dailyUsd ?? null;
  const globalDailySpend =
    (usage.globalDailyUsdUsed ?? 0) + (usage.globalDailyUsdReserved ?? 0);
  if (globalDailyCap !== null && globalDailyCap > 0 && globalDailySpend + estimate > globalDailyCap) {
    return buildDecision(ctx, {
      decision: "block",
      reasonCode: "global_daily_budget_exceeded",
      reason: `global daily budget exceeded (cap $${globalDailyCap})`,
      effectiveClass,
      useFallback: false,
    });
  }

  // ── Token gates (block on any breach) ──────────────────────────────────────
  // Worst-case token estimate reserved just like cost; enforced only where a
  // token cap is configured.
  const estTokens = estimateTokens(request.inputTokensEstimate, outputTokensForEstimate);

  const userTokenCap = userBudget.dailyTokens ?? null;
  if (userTokenCap !== null &&
      (usage.userDailyTokensUsed ?? 0) + (usage.userDailyTokensReserved ?? 0) + estTokens > userTokenCap) {
    return buildDecision(ctx, {
      decision: "block",
      reasonCode: "daily_token_limit_reached",
      reason: `user daily token limit reached (cap ${userTokenCap})`,
      effectiveClass,
      useFallback: false,
    });
  }

  const featureTokenCap = feature.budget?.monthlyTokens ?? null;
  if (featureTokenCap !== null &&
      (usage.featureMonthlyTokensUsed ?? 0) + (usage.featureMonthlyTokensReserved ?? 0) + estTokens > featureTokenCap) {
    return buildDecision(ctx, {
      decision: "block",
      reasonCode: "feature_monthly_token_limit_reached",
      reason: `feature monthly token limit reached (cap ${featureTokenCap})`,
      effectiveClass,
      useFallback: false,
    });
  }

  const globalTokenCap = global.monthlyTokens ?? null;
  if (globalTokenCap !== null &&
      (usage.globalMonthlyTokensUsed ?? 0) + (usage.globalMonthlyTokensReserved ?? 0) + estTokens > globalTokenCap) {
    return buildDecision(ctx, {
      decision: "block",
      reasonCode: "global_monthly_token_limit_reached",
      reason: `global monthly token limit reached (cap ${globalTokenCap})`,
      effectiveClass,
      useFallback: false,
    });
  }

  // ── Allowed (possibly degraded) ────────────────────────────────────────────
  return buildDecision(ctx, {
    decision: degraded ? "degrade" : "allow",
    reasonCode: degraded ? "global_budget_degraded" : undefined,
    reason: degraded
      ? `global budget >= ${config.routing.degradeAtPercent}% — degraded to '${effectiveClass}'`
      : undefined,
    effectiveClass,
    useFallback: false,
  });
}

/**
 * Returns a human-readable reason if the resolved model class / provider is not
 * permitted for the feature's data-sensitivity class, else null. No-op when the
 * feature declares no sensitivity or the class has no allow-lists.
 */
function checkDataSensitivity(
  config: ModelgovConfig,
  feature: FeatureConfig,
  modelClass: string,
  provider: string,
): string | null {
  const className = feature.dataSensitivity;
  if (!className) return null;
  const dc = config.dataClasses?.[className];
  if (!dc) return null;
  if (dc.allowedModelClasses && !dc.allowedModelClasses.includes(modelClass)) {
    return `data class '${className}' does not permit model_class '${modelClass}'`;
  }
  if (dc.allowedProviders && !dc.allowedProviders.includes(provider)) {
    return `data class '${className}' does not permit provider '${provider}'`;
  }
  return null;
}

// ── Internal decision builder ────────────────────────────────────────────────

interface BuildCtx {
  config: ModelgovConfig;
  feature: FeatureConfig;
  userBudget: UserTypeBudget;
  usage: UsageSnapshot;
  safetyPlan: SafetyPlan;
  /** Output tokens for the worst-case estimate (0 for embeddings). */
  outputTokensForEstimate: number;
  userId: string;
  featureName: string;
  inputTokensEstimate?: number;
}

interface BuildArgs {
  decision: PolicyDecisionKind;
  reason?: string;
  reasonCode?: PolicyDecision["reasonCode"];
  effectiveClass: string;
  useFallback: boolean;
}

function buildDecision(ctx: BuildCtx, args: BuildArgs): PolicyDecision {
  const { config, feature, userBudget, usage, safetyPlan } = ctx;
  const { model, provider, fallback } = resolveModelInfo(
    config,
    args.effectiveClass,
    args.useFallback,
  );
  const estimatedCostUsd = estimateForModel(
    config,
    model,
    ctx.inputTokensEstimate,
    ctx.outputTokensForEstimate,
  );
  const estimatedTokens = estimateTokens(ctx.inputTokensEstimate, ctx.outputTokensForEstimate);

  const global: GlobalBudget = config.budgets.global;
  const globalCap =
    global.monthlyUsd > 0
      ? global.monthlyUsd * (global.hardStopAtPercent / 100)
      : null;
  const globalDailyCap =
    global.dailyUsd != null && global.dailyUsd > 0 ? global.dailyUsd : null;
  const featureCap = feature.budget?.monthlyUsd ?? null;

  const userDailySpend = usage.userDailyUsdUsed + usage.userDailyUsdReserved;
  const featureSpend =
    usage.featureMonthlyUsdUsed + usage.featureMonthlyUsdReserved;
  const globalSpend =
    usage.globalMonthlyUsdUsed + usage.globalMonthlyUsdReserved;
  const globalDailySpend =
    (usage.globalDailyUsdUsed ?? 0) + (usage.globalDailyUsdReserved ?? 0);

  const userTokenCap = userBudget.dailyTokens ?? null;
  const featureTokenCap = feature.budget?.monthlyTokens ?? null;
  const globalTokenCap = global.monthlyTokens ?? null;
  const userTokens = (usage.userDailyTokensUsed ?? 0) + (usage.userDailyTokensReserved ?? 0);
  const featureTokens = (usage.featureMonthlyTokensUsed ?? 0) + (usage.featureMonthlyTokensReserved ?? 0);
  const globalTokens = (usage.globalMonthlyTokensUsed ?? 0) + (usage.globalMonthlyTokensReserved ?? 0);

  const budgetRemaining: BudgetRemaining = {
    userDailyUsd: roundUsd(userBudget.dailyUsd - userDailySpend),
    featureMonthlyUsd:
      featureCap !== null ? roundUsd(featureCap - featureSpend) : null,
    globalMonthlyUsd: globalCap !== null ? roundUsd(globalCap - globalSpend) : null,
    globalDailyUsd: globalDailyCap !== null ? roundUsd(globalDailyCap - globalDailySpend) : null,
    userDailyTokens: userTokenCap !== null ? userTokenCap - userTokens : null,
    featureMonthlyTokens: featureTokenCap !== null ? featureTokenCap - featureTokens : null,
    globalMonthlyTokens: globalTokenCap !== null ? globalTokenCap - globalTokens : null,
  };

  const reservationCaps: ReservationCaps = {
    userDailyUsd: userBudget.dailyUsd,
    userDailyRequests: userBudget.dailyRequests,
    featureMonthlyUsd: featureCap,
    globalMonthlyUsd: globalCap,
    globalDailyUsd: globalDailyCap,
    userDailyTokens: userTokenCap,
    featureMonthlyTokens: featureTokenCap,
    globalMonthlyTokens: globalTokenCap,
  };

  return {
    decision: args.decision,
    reason: args.reason,
    reasonCode: args.reasonCode,
    resolvedModelClass: args.effectiveClass,
    resolvedModel: model,
    resolvedProvider: provider,
    fallbackModel: fallback,
    safetyPreset: safetyPlan.preset,
    safetyPlan,
    maxOutputTokens: safetyPlan.maxOutputTokens,
    estimatedCostUsd,
    estimatedTokens,
    budgetRemaining,
    reservationCaps,
    traceTags: {
      userId: ctx.userId,
      feature: ctx.featureName,
      modelClass: args.effectiveClass,
      policyDecision: args.decision,
    },
  };
}
