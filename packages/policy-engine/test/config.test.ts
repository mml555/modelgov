import { describe, expect, it } from "vitest";
import { parseConfig, parseConfigObject } from "../src/config";
import { PolicyConfigError } from "../src/types";
import { RAW_CONFIG } from "./helpers";

describe("parseConfig", () => {
  it("parses YAML and maps snake_case to camelCase", () => {
    const yaml = `
project:
  name: demo
budgets:
  global:
    monthly_usd: 500
  by_user_type:
    logged_in:
      daily_usd: 0.25
      daily_requests: 50
      models: ["cheap"]
features:
  support_chat:
    model_class: cheap
    max_tokens: 500
model_classes:
  cheap:
    primary: openai/gpt-4o-mini
`;
    const cfg = parseConfig(yaml);
    expect(cfg.project.name).toBe("demo");
    expect(cfg.budgets.global.monthlyUsd).toBe(500);
    expect(cfg.budgets.byUserType.logged_in?.dailyRequests).toBe(50);
    expect(cfg.features.support_chat?.modelClass).toBe("cheap");
    expect(cfg.modelClasses.cheap?.primary).toBe("openai/gpt-4o-mini");
  });

  it("applies defaults for routing, safety, observability", () => {
    const cfg = parseConfig(`
project: { name: d }
budgets:
  global: { monthly_usd: 10 }
  by_user_type:
    logged_in: { daily_usd: 1, daily_requests: 10, models: ["cheap"] }
features:
  f: { model_class: cheap, max_tokens: 100 }
model_classes:
  cheap: { primary: openai/gpt-4o-mini }
`);
    expect(cfg.routing.degradeAtPercent).toBe(80);
    expect(cfg.safety.preset).toBe("balanced");
    expect(cfg.observability.provider).toBe("none");
    expect(cfg.project.environment).toBe("development");
  });

  it("normalizes a feature safety preset string into an override object", () => {
    const cfg = parseConfigObject(RAW_CONFIG);
    expect(cfg.features.support_chat?.safety).toEqual({ preset: "strict" });
  });

  it("rejects a feature referencing an unknown model class", () => {
    expect(() =>
      parseConfigObject({
        project: { name: "x" },
        budgets: {
          global: { monthly_usd: 1 },
          by_user_type: {
            logged_in: { daily_usd: 1, daily_requests: 1, models: ["cheap"] },
          },
        },
        features: { f: { model_class: "ghost", max_tokens: 10 } },
        model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
      }),
    ).toThrow(PolicyConfigError);
  });

  it("rejects a user type permitting an unknown model class", () => {
    expect(() =>
      parseConfigObject({
        project: { name: "x" },
        budgets: {
          global: { monthly_usd: 1 },
          by_user_type: {
            logged_in: { daily_usd: 1, daily_requests: 1, models: ["ghost"] },
          },
        },
        features: { f: { model_class: "cheap", max_tokens: 10 } },
        model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
      }),
    ).toThrow(/unknown model_class 'ghost'/);
  });

  it("throws a PolicyConfigError on malformed YAML", () => {
    expect(() => parseConfig(":\n  - [")).toThrow(PolicyConfigError);
  });

  it("rejects a misspelled budget cap key instead of silently dropping it (fail closed)", () => {
    // `montly_usd` would previously be ignored and the cap fall back to a
    // default — the exact fail-open a spend gate must never do.
    expect(() =>
      parseConfigObject({
        project: { name: "x" },
        budgets: {
          global: { montly_usd: 1 },
          by_user_type: { logged_in: { daily_usd: 1, daily_requests: 1, models: ["cheap"] } },
        },
        features: { f: { model_class: "cheap", max_tokens: 10 } },
        model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
      } as never),
    ).toThrow(PolicyConfigError);
  });

  it("rejects a misspelled safety protect key instead of failing open", () => {
    // `promptInjection` (camelCase, the TS type name) or any typo must be a loud
    // error — silently dropping it would resolve injection to off under a custom
    // preset. Same fail-closed stance as the budget caps.
    expect(() =>
      parseConfigObject({
        ...RAW_CONFIG,
        safety: {
          preset: "custom",
          protect: { pii: "block", promptInjection: "block" },
        },
      } as never),
    ).toThrow(PolicyConfigError);
  });

  it("rejects a misspelled data_classes key instead of dropping the restriction", () => {
    // `allowed_providrs` would otherwise be ignored → restricted data routes to
    // any provider (fail open on a data-sovereignty control).
    expect(() =>
      parseConfigObject({
        ...RAW_CONFIG,
        data_classes: { restricted: { allowed_providrs: ["azure"] } },
      } as never),
    ).toThrow(PolicyConfigError);
  });

  it("rejects a misspelled per-feature safety key", () => {
    expect(() =>
      parseConfigObject({
        ...RAW_CONFIG,
        features: {
          ...RAW_CONFIG.features,
          support_chat: { model_class: "cheap", max_tokens: 500, safety: { presett: "strict" } },
        },
      } as never),
    ).toThrow(PolicyConfigError);
  });

  it("rejects an injection_model whose provider is outside a restricted feature's data class", () => {
    // strict → prompt_injection: block; restricted data allows only azure, but the
    // injection classifier runs on openai → restricted text would be exfiltrated.
    expect(() =>
      parseConfigObject({
        ...RAW_CONFIG,
        features: {
          ...RAW_CONFIG.features,
          support_chat: {
            model_class: "cheap",
            max_tokens: 500,
            safety: "strict",
            data_sensitivity: "restricted",
          },
        },
        data_classes: { restricted: { allowed_providers: ["azure"] } },
        safety: { preset: "balanced", injection_model: "openai/gpt-4o-mini" },
      } as never),
    ).toThrow(/injection_model/);
  });

  it("allows an injection_model whose provider IS permitted by the data class", () => {
    expect(() =>
      parseConfigObject({
        ...RAW_CONFIG,
        features: {
          ...RAW_CONFIG.features,
          support_chat: {
            model_class: "cheap",
            max_tokens: 500,
            safety: "strict",
            data_sensitivity: "restricted",
          },
        },
        data_classes: { restricted: { allowed_providers: ["openai"] } },
        safety: { preset: "balanced", injection_model: "openai/gpt-4o-mini" },
      } as never),
    ).not.toThrow();
  });

  it("rejects an unknown top-level key", () => {
    expect(() =>
      parseConfigObject({
        project: { name: "x" },
        budgets: {
          global: { monthly_usd: 1 },
          by_user_type: { logged_in: { daily_usd: 1, daily_requests: 1, models: ["cheap"] } },
        },
        features: { f: { model_class: "cheap", max_tokens: 10 } },
        model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
        budgts: {},
      } as never),
    ).toThrow(PolicyConfigError);
  });

  it("rejects unpriced models when strictPricing is enabled", () => {
    expect(() =>
      parseConfigObject(
        {
          project: { name: "x" },
          budgets: {
            global: { monthly_usd: 1 },
            by_user_type: {
              logged_in: { daily_usd: 1, daily_requests: 1, models: ["cheap"] },
            },
          },
          features: { f: { model_class: "cheap", max_tokens: 10 } },
          model_classes: { cheap: { primary: "vendor/unknown-model" } },
        },
        { strictPricing: true },
      ),
    ).toThrow(/missing from PRICE_TABLE/);
  });

  it("allows ollama models without strict pricing errors", () => {
    const cfg = parseConfigObject(
      {
        project: { name: "x" },
        budgets: {
          global: { monthly_usd: 1 },
          by_user_type: {
            logged_in: { daily_usd: 1, daily_requests: 1, models: ["cheap"] },
          },
        },
        features: { f: { model_class: "cheap", max_tokens: 10 } },
        model_classes: { cheap: { primary: "ollama/llama3" } },
      },
      { strictPricing: true },
    );
    expect(cfg.modelClasses.cheap?.primary).toBe("ollama/llama3");
  });

  const withBilling = (billing: unknown) => ({
    project: { name: "x" },
    budgets: {
      global: { monthly_usd: 1 },
      by_user_type: { logged_in: { daily_usd: 1, daily_requests: 1, models: ["cheap"] } },
    },
    features: { f: { model_class: "cheap", max_tokens: 10 } },
    model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
    billing,
  });

  it("rejects prepaid credits combined with a Stripe usage meter (would double-bill)", () => {
    // credits mode debits the wallet AND a meter event would invoice the same
    // usage — the config must fail closed rather than charge twice.
    for (const mode of ["credits_only", "hybrid"]) {
      expect(() =>
        parseConfigObject(
          withBilling({
            provider: "stripe",
            mode,
            stripe: { meter_event_name: "modelgov_usage" },
          }),
        ),
      ).toThrow(PolicyConfigError);
    }
  });

  it("allows prepaid credits with Stripe used only for top-ups (no usage meter)", () => {
    const cfg = parseConfigObject(
      withBilling({
        provider: "stripe",
        mode: "credits_only",
        stripe: { secret_key: "sk_test", webhook_secret: "whsec", usd_per_credit: 0.01 },
      }),
    );
    expect(cfg.billing?.mode).toBe("credits_only");
    expect(cfg.billing?.stripe?.meterEventName).toBeUndefined();
  });

  it("rejects a usage meter in internal_only mode (nothing would ever report to it)", () => {
    expect(() =>
      parseConfigObject(
        withBilling({
          provider: "stripe",
          mode: "internal_only",
          stripe: { meter_event_name: "modelgov_usage" },
        }),
      ),
    ).toThrow(PolicyConfigError);
  });

  it("accepts metered mode with a Stripe meter event name", () => {
    const cfg = parseConfigObject(
      withBilling({
        provider: "stripe",
        mode: "metered",
        stripe: { secret_key: "sk_test", meter_event_name: "modelgov_usage" },
      }),
    );
    expect(cfg.billing?.mode).toBe("metered");
    expect(cfg.billing?.stripe?.meterEventName).toBe("modelgov_usage");
  });

  it("rejects metered mode without a meter event name or without the stripe provider", () => {
    expect(() =>
      parseConfigObject(
        withBilling({ provider: "stripe", mode: "metered", stripe: { secret_key: "sk_test" } }),
      ),
    ).toThrow(PolicyConfigError);
    expect(() =>
      parseConfigObject(
        withBilling({ provider: "custom", mode: "metered", stripe: { meter_event_name: "m" } }),
      ),
    ).toThrow(PolicyConfigError);
  });
});
