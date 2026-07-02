import { parseConfigObject } from "../src/config";
import type { AiGuardConfig, AiRequest, UsageSnapshot } from "../src/types";

// A self-consistent base config (snake_case raw → parsed) reused across tests.
export const RAW_CONFIG = {
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 100, alert_at_percent: 80, hard_stop_at_percent: 100 },
    by_user_type: {
      anonymous: { daily_usd: 0.02, daily_requests: 5, models: ["cheap"] },
      logged_in: {
        daily_usd: 0.25,
        daily_requests: 50,
        models: ["cheap", "standard"],
      },
      admin: {
        daily_usd: 5,
        daily_requests: 500,
        models: ["cheap", "standard", "premium"],
      },
    },
  },
  features: {
    support_chat: { safety: "strict", model_class: "cheap", max_tokens: 500 },
    premium_feature: { model_class: "premium", max_tokens: 1000 },
    capped_feature: {
      model_class: "cheap",
      max_tokens: 500,
      budget: { monthly_usd: 1 },
    },
  },
  routing: { degrade_at_percent: 80 },
  model_classes: {
    cheap: { primary: "openai/gpt-4o-mini", fallback: "anthropic/claude-haiku" },
    standard: { primary: "anthropic/claude-sonnet", fallback: "openai/gpt-4o" },
    premium: { primary: "openai/gpt-5", fallback: "anthropic/claude-opus" },
  },
  safety: {
    preset: "balanced",
    protect: { pii: "mask", prompt_injection: "block" },
    injection_model: "openai/gpt-4o-mini",
  },
};

export function baseConfig(): AiGuardConfig {
  return parseConfigObject(RAW_CONFIG);
}

export const ZERO_USAGE: UsageSnapshot = {
  userDailyUsdUsed: 0,
  userDailyUsdReserved: 0,
  userDailyRequestsUsed: 0,
  featureMonthlyUsdUsed: 0,
  featureMonthlyUsdReserved: 0,
  globalMonthlyUsdUsed: 0,
  globalMonthlyUsdReserved: 0,
};

export function usage(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return { ...ZERO_USAGE, ...overrides };
}

export function request(overrides: Partial<AiRequest> = {}): AiRequest {
  return {
    projectId: "proj",
    environment: "test",
    userId: "user-1",
    userType: "logged_in",
    feature: "support_chat",
    ...overrides,
  };
}
