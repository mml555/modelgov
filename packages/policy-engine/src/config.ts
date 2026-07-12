import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { findUnpricedModels } from "./cost";
import { providerOf } from "./routing";
import { resolveSafetyPlan } from "./safety";
import {
  PolicyConfigError,
  type ModelgovConfig,
  type FeatureSafetyOverride,
} from "./types";

// modelgov.yaml is authored in snake_case; we validate it and transform to the
// camelCase ModelgovConfig the engine consumes. env/VAR resolution for provider
// keys happens in the API layer, not here.

const presetEnum = z.enum(["dev", "balanced", "strict", "custom"]);

// .strict() for the same reason as the budget schemas: safety is a protection
// control, so a misspelled key (e.g. `promptInjection` in camelCase, or a typo)
// must be a loud config error, never silently dropped — a dropped protect key
// would fall back to the preset default and can fail OPEN (injection/pii off).
const protectSchema = z
  .object({
    pii: z.enum(["mask", "block", "off"]).optional(),
    pii_scope: z.enum(["input", "output", "both"]).optional(),
    prompt_injection: z.enum(["block", "off"]).optional(),
  })
  .strict()
  .transform((p) => ({ pii: p.pii, piiScope: p.pii_scope, promptInjection: p.prompt_injection }));

const projectSchema = z
  .object({
    name: z.string(),
    environment: z.string().default("development"),
  })
  .transform((p) => ({ name: p.name, environment: p.environment }));

// Provider entries are largely informational in the LiteLLM-proxy deployment
// (the proxy owns credentials + routing); the extra fields let non-api_key
// providers (Azure endpoint/version, Bedrock region, Vertex project/location)
// be expressed, and `billing` marks a custom subscription provider as $0-USD.
// `.strict()` so a misspelled key is a loud error, not a silently ignored one.
const providerSchema = z
  .object({
    api_key: z.string().optional(),
    api_base: z.string().optional(),
    api_version: z.string().optional(),
    region: z.string().optional(),
    project: z.string().optional(),
    location: z.string().optional(),
    auth: z.enum(["api_key", "aws", "gcp", "oauth_device", "local"]).optional(),
    billing: z.enum(["per_token", "subscription"]).optional(),
  })
  .strict()
  .transform((p) => ({
    apiKey: p.api_key,
    apiBase: p.api_base,
    apiVersion: p.api_version,
    region: p.region,
    project: p.project,
    location: p.location,
    auth: p.auth,
    billing: p.billing,
  }));

// .strict() throughout the budget/cap schemas: this is a spend-ENFORCEMENT
// product, so a misspelled cap key (`montly_usd`, `hard_stop_percent`) must be a
// loud config error, never silently dropped — dropping it would fall back to the
// default (often "no cap") and fail OPEN on the exact control the operator meant
// to set.
const globalBudgetSchema = z
  .object({
    monthly_usd: z.number().nonnegative(),
    alert_at_percent: z.number().min(0).max(100).default(80),
    hard_stop_at_percent: z.number().min(0).max(1000).default(100),
    monthly_tokens: z.number().int().positive().optional(),
    daily_usd: z.number().nonnegative().optional(),
  })
  .strict()
  .transform((g) => ({
    monthlyUsd: g.monthly_usd,
    alertAtPercent: g.alert_at_percent,
    hardStopAtPercent: g.hard_stop_at_percent,
    monthlyTokens: g.monthly_tokens,
    dailyUsd: g.daily_usd,
  }));

const userTypeBudgetSchema = z
  .object({
    daily_usd: z.number().nonnegative(),
    daily_requests: z.number().int().nonnegative(),
    models: z.array(z.string()).min(1),
    daily_tokens: z.number().int().positive().optional(),
  })
  .strict()
  .transform((u) => ({
    dailyUsd: u.daily_usd,
    dailyRequests: u.daily_requests,
    models: u.models,
    dailyTokens: u.daily_tokens,
  }));

const groundingEnum = z.enum(["off", "strict"]);

const featureSafetySchema = z.union([
  presetEnum,
  z
    .object({
      preset: presetEnum.optional(),
      protect: protectSchema.optional(),
      grounding: groundingEnum.optional(),
    })
    .strict(),
]);

const featureSchema = z
  .object({
    safety: featureSafetySchema.optional(),
    model_class: z.string(),
    max_tokens: z.number().int().positive(),
    budget: z
      .object({
        monthly_usd: z.number().nonnegative().optional(),
        monthly_tokens: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    data_sensitivity: z.string().optional(),
    retention_days: z.number().int().positive().optional(),
  })
  .strict()
  .transform((f) => ({
    safety: normalizeFeatureSafety(f.safety),
    modelClass: f.model_class,
    maxTokens: f.max_tokens,
    budget: f.budget
      ? { monthlyUsd: f.budget.monthly_usd, monthlyTokens: f.budget.monthly_tokens }
      : undefined,
    dataSensitivity: f.data_sensitivity,
    retentionDays: f.retention_days,
  }));

const dataClassSchema = z
  .object({
    allowed_model_classes: z.array(z.string()).optional(),
    allowed_providers: z.array(z.string()).optional(),
  })
  // .strict(): a typo like `allowed_providrs` must fail loudly, not silently
  // drop the restriction and let restricted-class data route to any provider.
  .strict()
  .transform((d) => ({
    allowedModelClasses: d.allowed_model_classes,
    allowedProviders: d.allowed_providers,
  }));

const modelClassSchema = z
  .object({
    primary: z.string(),
    fallback: z.string().optional(),
  })
  .strict();

const routingSchema = z
  .object({
    degrade_at_percent: z.number().min(0).max(100).default(80),
    class_order: z.array(z.string().min(1)).min(1).optional(),
    retry: z
      .object({
        max_attempts: z.number().int().positive().max(10).default(3),
        backoff_ms: z.array(z.number().int().nonnegative()).min(1).default([500, 2000, 8000]),
        retry_on: z.array(z.number().int().positive()).default([429, 502, 503]),
        respect_retry_after: z.boolean().default(true),
      })
      .strict()
      .optional(),
  })
  .transform((r) => ({
    degradeAtPercent: r.degrade_at_percent,
    classOrder: r.class_order,
    retry: r.retry
      ? {
          maxAttempts: r.retry.max_attempts,
          backoffMs: r.retry.backoff_ms,
          retryOn: r.retry.retry_on,
          respectRetryAfter: r.retry.respect_retry_after,
        }
      : undefined,
  }));

const billingSchema = z
  .object({
    provider: z.enum(["none", "stripe", "custom"]).default("none"),
    mode: z.enum(["internal_only", "metered", "hybrid", "credits_only"]).default("internal_only"),
    stripe: z
      .object({
        secret_key: z.string().optional(),
        webhook_secret: z.string().optional(),
        plan_map: z.record(z.string(), z.string()).optional(),
        usd_per_credit: z.number().positive().optional(),
        meter_event_name: z.string().optional(),
        downgrade_user_type: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    // Prepaid credits and Stripe metered billing are mutually exclusive: both
    // charge for the same usage (a credit-wallet debit AND a metered invoice),
    // so enabling both double-bills the customer. Reject at config load rather
    // than silently double-charge. Prepaid credits still use Stripe for
    // top-ups (Checkout webhooks) — only the usage meter is disallowed here.
    const usesCredits = b.mode === "hybrid" || b.mode === "credits_only";
    if (usesCredits && b.stripe?.meter_event_name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stripe", "meter_event_name"],
        message:
          `billing.mode "${b.mode}" bills usage by debiting the prepaid credit wallet, ` +
          "so billing.stripe.meter_event_name (a Stripe usage meter) must not be set — " +
          "it would invoice the same usage a second time. Remove meter_event_name; Stripe " +
          'is still used to sell credits (plan_map / Checkout webhooks). To bill usage via a Stripe meter instead, use mode "metered".',
      });
    }
    // A meter event name outside metered mode is a config smell: in
    // internal_only nothing would ever report to it (the billing service is not
    // constructed), so the operator who set it is expecting invoices that will
    // never arrive. Fail fast and point at the mode that delivers them.
    if (b.mode === "internal_only" && b.stripe?.meter_event_name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stripe", "meter_event_name"],
        message:
          'billing.stripe.meter_event_name has no effect in mode "internal_only" — usage is never reported. Use mode "metered" to bill usage via this Stripe Billing Meter.',
      });
    }
    // Metered mode invoices usage through a Stripe Billing Meter, so it needs
    // the meter's event name and the Stripe provider — nothing else can deliver
    // the usage records.
    if (b.mode === "metered") {
      if (b.provider !== "stripe") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["provider"],
          message: 'billing.mode "metered" requires billing.provider "stripe" (usage is reported to a Stripe Billing Meter).',
        });
      }
      if (!b.stripe?.meter_event_name) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stripe", "meter_event_name"],
          message: 'billing.mode "metered" requires billing.stripe.meter_event_name — the Stripe Billing Meter event that usage is reported to.',
        });
      }
    }
  })
  .transform((b) => ({
    provider: b.provider,
    mode: b.mode,
    stripe: b.stripe
      ? {
          secretKey: b.stripe.secret_key,
          webhookSecret: b.stripe.webhook_secret,
          planMap: b.stripe.plan_map,
          usdPerCredit: b.stripe.usd_per_credit,
          meterEventName: b.stripe.meter_event_name,
          downgradeUserType: b.stripe.downgrade_user_type,
        }
      : undefined,
  }));

const safetySchema = z
  .object({
    preset: presetEnum.default("balanced"),
    protect: protectSchema.optional(),
    injection_model: z.string().optional(),
    grounding: groundingEnum.optional(),
  })
  .strict()
  .transform((s) => ({
    preset: s.preset,
    protect: s.protect ?? { pii: undefined, promptInjection: undefined },
    injectionModel: s.injection_model,
    grounding: s.grounding,
  }));

const observabilitySchema = z.object({
  provider: z.enum(["none", "langfuse", "otel"]).default("none"),
});

const pricingSchema = z.record(
  z.string(),
  z
    .object({
      input_per_1k: z.number().nonnegative(),
      output_per_1k: z.number().nonnegative(),
    })
    .transform((p) => ({ inputPer1k: p.input_per_1k, outputPer1k: p.output_per_1k })),
);

const configSchema = z
  .object({
    project: projectSchema,
    providers: z.record(z.string(), providerSchema).default({}),
    budgets: z
      .object({
        global: globalBudgetSchema,
        by_user_type: z.record(z.string(), userTypeBudgetSchema),
      })
      .transform((b) => ({ global: b.global, byUserType: b.by_user_type })),
    features: z.record(z.string(), featureSchema),
    routing: routingSchema.optional(),
    model_classes: z.record(z.string(), modelClassSchema),
    safety: safetySchema.optional(),
    observability: observabilitySchema.optional(),
    data_classes: z.record(z.string(), dataClassSchema).optional(),
    pricing: pricingSchema.optional(),
    billing: billingSchema.optional(),
  })
  .strict()
  .transform((c) => ({
    project: c.project,
    providers: c.providers,
    budgets: c.budgets,
    features: c.features,
    routing: c.routing ?? { degradeAtPercent: 80 },
    modelClasses: c.model_classes,
    safety:
      c.safety ?? {
        preset: "balanced" as const,
        protect: { pii: undefined, promptInjection: undefined },
        injectionModel: undefined,
      },
    observability: c.observability ?? { provider: "none" as const },
    dataClasses: c.data_classes,
    pricing: c.pricing,
    billing: c.billing,
  }));

function normalizeFeatureSafety(
  s: z.infer<typeof featureSafetySchema> | undefined,
): FeatureSafetyOverride | undefined {
  if (s == null) return undefined;
  if (typeof s === "string") return { preset: s };
  return { preset: s.preset, protect: s.protect, grounding: s.grounding };
}

/** Validate cross-references that zod's per-field schema can't express. */
function validateRefs(
  config: ModelgovConfig,
  options?: { strictPricing?: boolean },
): void {
  for (const [name, feature] of Object.entries(config.features)) {
    if (!config.modelClasses[feature.modelClass]) {
      throw new PolicyConfigError(
        `feature '${name}' references unknown model_class '${feature.modelClass}'`,
        "invalid_config",
      );
    }
  }
  for (const [userType, budget] of Object.entries(config.budgets.byUserType)) {
    for (const cls of budget.models) {
      if (!config.modelClasses[cls]) {
        throw new PolicyConfigError(
          `user_type '${userType}' permits unknown model_class '${cls}'`,
          "invalid_config",
        );
      }
    }
  }

  // routing.class_order entries must be defined model classes.
  for (const cls of config.routing.classOrder ?? []) {
    if (!config.modelClasses[cls]) {
      throw new PolicyConfigError(
        `routing.class_order references unknown model_class '${cls}'`,
        "invalid_config",
      );
    }
  }

  // Data-sensitivity governance references must resolve.
  for (const [name, feature] of Object.entries(config.features)) {
    if (feature.dataSensitivity && !config.dataClasses?.[feature.dataSensitivity]) {
      throw new PolicyConfigError(
        `feature '${name}' references unknown data_sensitivity class '${feature.dataSensitivity}'`,
        "invalid_config",
      );
    }
  }
  for (const [cls, dc] of Object.entries(config.dataClasses ?? {})) {
    for (const mc of dc.allowedModelClasses ?? []) {
      if (!config.modelClasses[mc]) {
        throw new PolicyConfigError(
          `data class '${cls}' allows unknown model_class '${mc}'`,
          "invalid_config",
        );
      }
    }
  }

  // A feature that hard-BLOCKS prompt injection sends its full text to the
  // injection classifier's model BEFORE any block decision. For a data-class-
  // restricted feature, that model's provider must itself be permitted by the
  // class — otherwise restricted data is exfiltrated to an unapproved provider by
  // the safety layer, bypassing the data-sovereignty gate the class enforces.
  const injectionModel = config.safety.injectionModel;
  // A `local/`- or `ollama/`-routed classifier screens on-box and never sends
  // restricted text to an external provider, so it satisfies any data class.
  const injectionIsLocal =
    !!injectionModel && (injectionModel.startsWith("local/") || injectionModel.startsWith("ollama/"));
  if (injectionModel && !injectionIsLocal) {
    const injectionProvider = providerOf(injectionModel);
    for (const [name, feature] of Object.entries(config.features)) {
      if (!feature.dataSensitivity) continue;
      const dc = config.dataClasses?.[feature.dataSensitivity];
      if (!dc?.allowedProviders) continue;
      const plan = resolveSafetyPlan(config, feature);
      if (plan.promptInjection === "block" && !dc.allowedProviders.includes(injectionProvider)) {
        throw new PolicyConfigError(
          `feature '${name}' has data_sensitivity '${feature.dataSensitivity}' (allowed providers: ${dc.allowedProviders.join(", ")}) but safety.injection_model '${injectionModel}' routes to provider '${injectionProvider}', which is not permitted — restricted data would be sent to an unapproved provider for injection screening`,
          "invalid_config",
        );
      }
    }
  }

  const unpriced = findUnpricedModels(config);
  if (unpriced.length > 0) {
    const detail = `model(s) missing from PRICE_TABLE (budget estimates use DEFAULT_PRICE): ${unpriced.join(", ")}`;
    if (options?.strictPricing) {
      throw new PolicyConfigError(detail, "unpriced_models");
    }
  }
}

/** Parse + validate a config object (already-loaded YAML/JSON). */
export function parseConfigObject(
  raw: unknown,
  options?: { strictPricing?: boolean },
): ModelgovConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new PolicyConfigError(
      `invalid modelgov config: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      "invalid_config",
    );
  }
  const config = result.data as ModelgovConfig;
  validateRefs(config, options);
  return config;
}

/** Parse + validate an modelgov.yaml document from its text. */
export function parseConfig(
  yamlText: string,
  options?: { strictPricing?: boolean },
): ModelgovConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    throw new PolicyConfigError(
      `failed to parse YAML: ${(e as Error).message}`,
      "invalid_yaml",
    );
  }
  return parseConfigObject(raw, options);
}
