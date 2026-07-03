import { describe, expect, it } from "vitest";
import { parseConfigObject } from "@modelgov/policy-engine";
import { createBillingService } from "../src/modules/billing/service";
import { verifyStripeWebhookSignature } from "../src/modules/billing/stripe";

describe("billing service", () => {
  it("parses billing config from yaml object", () => {
    const cfg = parseConfigObject({
      project: { name: "t", environment: "dev" },
      providers: {},
      budgets: {
        global: { monthly_usd: 100 },
        by_user_type: {
          free: { daily_usd: 1, daily_requests: 10, models: ["cheap"] },
        },
      },
      features: {
        chat: { model_class: "cheap", max_tokens: 100 },
      },
      model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
      billing: {
        provider: "stripe",
        mode: "hybrid",
        stripe: {
          plan_map: { price_pro: "paid_user" },
          meter_event_name: "ai_tokens",
        },
      },
    });
    expect(cfg.billing?.mode).toBe("hybrid");
    expect(cfg.billing?.stripe?.planMap?.price_pro).toBe("paid_user");
  });

  it("is disabled when billing mode is internal_only", () => {
    const cfg = parseConfigObject({
      project: { name: "t", environment: "dev" },
      providers: {},
      budgets: {
        global: { monthly_usd: 0 },
        by_user_type: {
          free: { daily_usd: 1, daily_requests: 10, models: ["cheap"] },
        },
      },
      features: {
        chat: { model_class: "cheap", max_tokens: 100 },
      },
      model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
      billing: { provider: "none", mode: "internal_only" },
    });
    const svc = createBillingService({ query: async () => ({ rows: [] }) } as never, {
      billing: cfg.billing,
    });
    expect(svc).toBeUndefined();
  });
});

describe("stripe webhook signature", () => {
  it("rejects invalid signatures", () => {
    const ok = verifyStripeWebhookSignature(
      Buffer.from('{"id":"evt_1"}'),
      "t=1,v1=deadbeef",
      "whsec_test",
    );
    expect(ok).toBe(false);
  });
});
