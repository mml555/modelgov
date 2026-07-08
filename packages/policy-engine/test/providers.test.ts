import { describe, expect, it } from "vitest";
import {
  buildBuiltinPriceTable,
  isSubscriptionModel,
  PROVIDER_REGISTRY,
  providerCredentialEnvVars,
  providerSpecOf,
} from "../src/providers";
import { PRICE_TABLE, getModelPrice, isPricingExemptModel } from "../src/cost";

describe("provider registry", () => {
  it("every registry slug equals its own key (providerOf relies on this)", () => {
    for (const [key, spec] of Object.entries(PROVIDER_REGISTRY)) {
      expect(spec.slug).toBe(key);
    }
  });

  it("every price key is prefixed by its provider's slug", () => {
    for (const spec of Object.values(PROVIDER_REGISTRY)) {
      for (const model of Object.keys(spec.prices ?? {})) {
        expect(model.startsWith(`${spec.slug}/`)).toBe(true);
      }
    }
  });

  it("PRICE_TABLE is exactly the merge of the registry's prices", () => {
    expect(PRICE_TABLE).toEqual(buildBuiltinPriceTable());
    // Long-standing entries are unchanged.
    expect(PRICE_TABLE["openai/gpt-4o-mini"]).toEqual({ inputPer1k: 0.00015, outputPer1k: 0.0006 });
    expect(PRICE_TABLE["azure_ai/claude-opus-4-1"]).toEqual({ inputPer1k: 0.015, outputPer1k: 0.075 });
    // A newly first-class provider is priced.
    expect(PRICE_TABLE["bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0"]).toEqual({ inputPer1k: 0.003, outputPer1k: 0.015 });
  });

  it("providerSpecOf resolves by model prefix and is undefined for unknowns", () => {
    expect(providerSpecOf("bedrock/anything")?.slug).toBe("bedrock");
    expect(providerSpecOf("github_copilot/gpt-4o")?.slug).toBe("github_copilot");
    expect(providerSpecOf("madeup/model")).toBeUndefined();
  });

  it("recognizes GitHub Copilot as a subscription provider", () => {
    expect(isSubscriptionModel("github_copilot/gpt-4o")).toBe(true);
    expect(PROVIDER_REGISTRY["github_copilot"]!.billingKind).toBe("subscription");
    // Per-token providers are not subscription.
    expect(isSubscriptionModel("bedrock/anthropic.claude-3-opus-20240229-v1:0")).toBe(false);
    expect(isSubscriptionModel("openai/gpt-4o")).toBe(false);
  });

  it("subscription models price at $0 and are pricing-exempt", () => {
    expect(getModelPrice("github_copilot/gpt-4o")).toEqual({ inputPer1k: 0, outputPer1k: 0 });
    expect(isPricingExemptModel("github_copilot/gpt-4o")).toBe(true);
    // An explicit override still wins over the subscription zero.
    const over = { "github_copilot/gpt-4o": { inputPer1k: 1, outputPer1k: 2 } };
    expect(getModelPrice("github_copilot/gpt-4o", over)).toEqual({ inputPer1k: 1, outputPer1k: 2 });
  });

  it("exposes the union of credential env vars for the API allowlist", () => {
    const vars = providerCredentialEnvVars();
    expect(vars).toContain("AWS_ACCESS_KEY_ID");
    expect(vars).toContain("GOOGLE_APPLICATION_CREDENTIALS");
    expect(vars).toContain("AZURE_API_BASE");
    expect(vars).toContain("GITHUB_COPILOT_TOKEN");
  });
});
