import { readFileSync } from "node:fs";
import {
  findUnpricedModels,
  parseConfig,
  resolveSafetyPlan,
  type ModelgovConfig,
} from "@modelgov/policy-engine";
import { resolveUserPath } from "./paths.js";

export interface ValidateIssue {
  level: "error" | "warn";
  code: string;
  message: string;
}

export interface ValidateResult {
  ok: boolean;
  issues: ValidateIssue[];
}

export interface ValidateOptions {
  configPath: string;
  production?: boolean;
  env?: Record<string, string | undefined>;
}

export function validateConfig(options: ValidateOptions): ValidateResult {
  const env = options.env ?? process.env;
  const text = readFileSync(resolveUserPath(options.configPath, env), "utf8");
  const config = parseConfig(text, { strictPricing: options.production });
  const issues: ValidateIssue[] = [];

  if (options.production) {
    validateProduction(config, env, issues);
  }

  validateAlways(config, issues);

  const errors = issues.filter((i) => i.level === "error");
  return { ok: errors.length === 0, issues };
}

function validateAlways(config: ModelgovConfig, issues: ValidateIssue[]): void {
  if (Object.keys(config.features).length === 0) {
    issues.push({
      level: "error",
      code: "no_features",
      message: "At least one feature must be defined",
    });
  }

  const unpriced = findUnpricedModels(config);
  for (const model of unpriced) {
    issues.push({
      level: "warn",
      code: "unpriced_model",
      message: `Model '${model}' has no static price entry — cost estimates may be inaccurate`,
    });
  }

  for (const [name, mc] of Object.entries(config.modelClasses)) {
    if (!mc.fallback) {
      issues.push({
        level: "warn",
        code: "missing_fallback",
        message: `model_classes.${name} has no fallback model`,
      });
    }
  }
}

function validateProduction(
  config: ModelgovConfig,
  env: Record<string, string | undefined>,
  issues: ValidateIssue[],
): void {
  if (config.project.environment !== "production") {
    issues.push({
      level: "warn",
      code: "environment_not_production",
      message: `project.environment is '${config.project.environment}' — expected 'production'`,
    });
  }

  const global = config.budgets.global;
  if (global.monthlyUsd <= 0) {
    issues.push({
      level: "error",
      code: "no_global_budget",
      message: "budgets.global.monthly_usd must be > 0 in production",
    });
  }

  if (global.hardStopAtPercent < 100) {
    issues.push({
      level: "warn",
      code: "soft_global_stop",
      message: `hard_stop_at_percent is ${global.hardStopAtPercent} — production usually uses 100`,
    });
  }

  if (config.safety.preset === "dev") {
    issues.push({
      level: "error",
      code: "unsafe_dev_preset",
      message: "safety.preset 'dev' disables protections — not allowed in production",
    });
  }

  for (const [featureName, feature] of Object.entries(config.features)) {
    if (!feature.safety) {
      issues.push({
        level: "error",
        code: "feature_missing_safety",
        message: `features.${featureName} has no safety preset — set safety: strict|balanced|custom`,
      });
    }
    const plan = resolveSafetyPlan(config, feature);
    if (plan.preset === "dev") {
      issues.push({
        level: "error",
        code: "feature_dev_safety",
        message: `features.${featureName} resolves to dev safety — not allowed in production`,
      });
    }
  }

  const anonymous = config.budgets.byUserType.anonymous;
  if (anonymous?.models.includes("premium")) {
    issues.push({
      level: "error",
      code: "anonymous_premium",
      message: "anonymous user type must not include premium model class",
    });
  }

  // Validate every `env/VAR` credential ref an operator explicitly wrote on a
  // provider (api_key, but also api_base/region/etc. for non-api_key providers).
  // We only check refs written into modelgov.yaml — in the proxy deployment
  // LiteLLM reads provider creds from its own env, which modelgov can't see, so
  // absence of a ref is not itself an error.
  for (const [providerName, provider] of Object.entries(config.providers)) {
    const refs = [
      provider.apiKey,
      provider.apiBase,
      provider.apiVersion,
      provider.region,
      provider.project,
      provider.location,
    ];
    for (const ref of refs) {
      if (!ref?.startsWith("env/")) continue;
      const varName = ref.slice(4);
      if (!env[varName]) {
        issues.push({
          level: "error",
          code: "missing_provider_key",
          message: `Provider '${providerName}' requires ${varName} to be set`,
        });
      }
    }
  }

  if (config.observability.provider === "langfuse") {
    if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
      issues.push({
        level: "error",
        code: "langfuse_misconfigured",
        message: "observability.provider is langfuse but LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY is missing",
      });
    }
  }

  for (const [userType, budget] of Object.entries(config.budgets.byUserType)) {
    for (const modelClass of budget.models) {
      if (!config.modelClasses[modelClass]) {
        issues.push({
          level: "error",
          code: "unknown_model_class",
          message: `by_user_type.${userType} references unknown model class '${modelClass}'`,
        });
      }
    }
  }

  auditFeatureSafety(config, issues);
}

function auditFeatureSafety(config: ModelgovConfig, issues: ValidateIssue[]): void {
  for (const [name, feature] of Object.entries(config.features)) {
    if (!feature.maxTokens || feature.maxTokens > 8000) {
      issues.push({
        level: "warn",
        code: "high_max_tokens",
        message: `features.${name}.max_tokens is ${feature.maxTokens} — consider lowering for cost control`,
      });
    }
  }
}

export function formatValidateResult(result: ValidateResult): string {
  if (result.issues.length === 0) {
    return "✓ Configuration is valid";
  }
  const lines = result.issues.map((issue) => {
    const icon = issue.level === "error" ? "✗" : "⚠";
    return `${icon} [${issue.code}] ${issue.message}`;
  });
  return lines.join("\n");
}
