import { describe, expect, it } from "vitest";
import { parseConfigObject } from "../src/config";
import { evaluateAiRequest } from "../src/evaluator";
import { PolicyConfigError } from "../src/types";
import { usage } from "./helpers";

const RAW = {
  project: { name: "t", environment: "test" },
  budgets: {
    global: { monthly_usd: 100, hard_stop_at_percent: 100 },
    by_user_type: { staff: { daily_usd: 5, daily_requests: 100, models: ["cheap", "onprem"] } },
  },
  features: {
    // Handles restricted data → only the on-prem class is approved.
    hr_chat: { model_class: "cheap", max_tokens: 200, data_sensitivity: "restricted", safety: "dev" },
    // Handles restricted data and already routes to the approved class.
    hr_chat_ok: { model_class: "onprem", max_tokens: 200, data_sensitivity: "restricted", safety: "dev" },
    // No sensitivity → unrestricted.
    marketing: { model_class: "cheap", max_tokens: 200, safety: "dev" },
  },
  model_classes: {
    cheap: { primary: "openai/gpt-4o-mini" },
    onprem: { primary: "ollama/llama3" },
  },
  safety: { preset: "dev" },
  data_classes: {
    restricted: { allowed_model_classes: ["onprem"], allowed_providers: ["ollama"] },
  },
};

function req(feature: string, userType = "staff") {
  return { projectId: "p", environment: "test", userId: "u", userType, feature };
}

describe("data-sensitivity governance", () => {
  const config = parseConfigObject(RAW);

  it("blocks a restricted feature routed to a non-approved model class", () => {
    const d = evaluateAiRequest({ request: req("hr_chat"), config, usage: usage() });
    expect(d.decision).toBe("block");
    expect(d.reasonCode).toBe("data_sensitivity_not_permitted");
    expect(d.reason).toMatch(/restricted/);
  });

  it("allows a restricted feature on the approved class + provider", () => {
    const d = evaluateAiRequest({ request: req("hr_chat_ok"), config, usage: usage() });
    expect(d.decision).toBe("allow");
    expect(d.resolvedModelClass).toBe("onprem");
    expect(d.resolvedProvider).toBe("ollama");
  });

  it("does not gate features without a data-sensitivity class", () => {
    const d = evaluateAiRequest({ request: req("marketing"), config, usage: usage() });
    expect(d.decision).toBe("allow");
  });

  it("blocks on provider even when the model class is allowed", () => {
    // restricted allows model class 'x' but only provider 'ollama'; route to an
    // openai-backed class → provider violation.
    const cfg = parseConfigObject({
      ...RAW,
      features: {
        leaky: { model_class: "cheap", max_tokens: 200, data_sensitivity: "restricted", safety: "dev" },
      },
      data_classes: { restricted: { allowed_model_classes: ["cheap"], allowed_providers: ["ollama"] } },
      budgets: {
        global: { monthly_usd: 100, hard_stop_at_percent: 100 },
        by_user_type: { staff: { daily_usd: 5, daily_requests: 100, models: ["cheap"] } },
      },
    });
    const d = evaluateAiRequest({ request: req("leaky"), config: cfg, usage: usage() });
    expect(d.decision).toBe("block");
    expect(d.reasonCode).toBe("data_sensitivity_not_permitted");
    expect(d.reason).toMatch(/provider/);
  });

  it("rejects config referencing an unknown data class", () => {
    expect(() =>
      parseConfigObject({
        ...RAW,
        features: { bad: { model_class: "cheap", max_tokens: 200, data_sensitivity: "nope", safety: "dev" } },
      }),
    ).toThrow(PolicyConfigError);
  });

  it("rejects a data class that allows an unknown model class", () => {
    expect(() =>
      parseConfigObject({
        ...RAW,
        data_classes: { restricted: { allowed_model_classes: ["ghost"] } },
      }),
    ).toThrow(PolicyConfigError);
  });
});
