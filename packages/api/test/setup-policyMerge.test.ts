import { describe, expect, it } from "vitest";
import { preserveBootOnlyPolicyYaml } from "../src/modules/setup/policyMerge";

const ACTIVE = `
routing:
  degrade_at_percent: 80
  retry:
    max_attempts: 3
    backoff_ms: [500, 2000, 8000]
    retry_on: [429, 502, 503]
    respect_retry_after: true
safety:
  preset: balanced
  injection_model: openai/gpt-4o-mini
`;

const GENERATED = `
routing:
  degrade_at_percent: 80
safety:
  preset: balanced
  injection_model: openai/gpt-4o-mini
budgets:
  global:
    monthly_usd: 200
`;

describe("preserveBootOnlyPolicyYaml", () => {
  it("copies routing.retry from the active version when the wizard omits it", () => {
    const merged = preserveBootOnlyPolicyYaml(GENERATED, ACTIVE);
    expect(merged).toContain("max_attempts: 3");
    expect(merged).toContain("respect_retry_after: true");
  });

  it("leaves wizard budget changes intact", () => {
    const merged = preserveBootOnlyPolicyYaml(GENERATED, ACTIVE);
    expect(merged).toContain("monthly_usd: 200");
  });
});
