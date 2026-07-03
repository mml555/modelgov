import type { BudgetRemaining, PolicyDecision, PolicyReasonCode } from "@modelgov/policy-engine";
import type { BudgetScope } from "./modules/usage/repo";

/** Fields promoted to the top-level `error` object for stable client contracts. */
export interface PolicyErrorContext {
  decision: string;
  feature: string;
  userType: string;
  userId: string;
  reason?: string;
  reasonCode?: PolicyReasonCode | string;
  budgetRemaining?: BudgetRemaining;
  resolvedModelClass?: string;
  scope?: BudgetScope;
}

export function policyErrorFromDecision(
  decision: PolicyDecision,
  ctx: { userId: string; userType: string; feature: string },
): PolicyErrorContext {
  return {
    decision: decision.decision,
    feature: ctx.feature,
    userType: ctx.userType,
    userId: ctx.userId,
    reason: decision.reason,
    reasonCode: decision.reasonCode,
    budgetRemaining: decision.budgetRemaining,
    resolvedModelClass: decision.resolvedModelClass,
  };
}

const SCOPE_REASON_CODES: Record<BudgetScope, PolicyReasonCode> = {
  user_daily: "daily_budget_exceeded",
  feature_monthly: "feature_monthly_budget_exceeded",
  global_monthly: "global_monthly_budget_exceeded",
  global_daily: "global_daily_budget_exceeded",
};

export function budgetErrorContext(
  scope: BudgetScope | undefined,
  ctx: { userId: string; userType: string; feature: string },
  budgetRemaining: BudgetRemaining,
): PolicyErrorContext {
  const reasonCode = scope ? SCOPE_REASON_CODES[scope] : "daily_budget_exceeded";
  const scopeLabel = scope ?? "unknown";
  return {
    decision: "block",
    feature: ctx.feature,
    userType: ctx.userType,
    userId: ctx.userId,
    reasonCode,
    reason: `Budget exceeded (${scopeLabel})`,
    budgetRemaining,
    scope,
  };
}

export function policyErrorMessage(
  code: "policy_blocked" | "budget_exceeded",
  ctx: PolicyErrorContext,
): string {
  if (code === "budget_exceeded") {
    return `Budget exceeded for ${ctx.userType} on feature ${ctx.feature}`;
  }
  if (ctx.reasonCode === "model_class_not_permitted") {
    return `Model class not permitted for user type ${ctx.userType}`;
  }
  if (ctx.reasonCode === "daily_request_limit_reached") {
    return `Daily request limit reached for user type ${ctx.userType}`;
  }
  if (ctx.reasonCode === "daily_budget_exceeded") {
    return `Daily budget exceeded for user type ${ctx.userType}`;
  }
  return ctx.reason ?? "Policy blocked";
}
