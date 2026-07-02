import { describe, expect, it } from "vitest";
import { evaluateAiRequest } from "../src/evaluator";
import { baseConfig, request, usage } from "./helpers";

const config = baseConfig();

describe("policy regression snapshots", () => {
  const cases = [
    {
      name: "logged_in + support_chat + cheap → allow",
      input: request(),
      usage: usage(),
      snapshot: {
        decision: "allow",
        resolvedModelClass: "cheap",
        resolvedModel: "openai/gpt-4o-mini",
        reasonCode: undefined,
      },
    },
    {
      name: "anonymous + standard → block model_class_not_permitted",
      input: request({ userType: "anonymous", requestedModelClass: "standard" }),
      usage: usage(),
      snapshot: {
        decision: "block",
        reasonCode: "model_class_not_permitted",
        resolvedModelClass: "standard",
      },
    },
    {
      name: "logged_in at daily request limit → block",
      input: request(),
      usage: usage({ userDailyRequestsUsed: 50 }),
      snapshot: {
        decision: "block",
        reasonCode: "daily_request_limit_reached",
      },
    },
    {
      name: "logged_in over daily USD → block",
      input: request(),
      usage: usage({ userDailyUsdUsed: 0.25 }),
      snapshot: {
        decision: "block",
        reasonCode: "daily_budget_exceeded",
      },
    },
    {
      name: "admin at global degrade threshold → degrade",
      input: request({ userType: "admin", feature: "premium_feature" }),
      usage: usage({ globalMonthlyUsdUsed: 85 }),
      snapshot: {
        decision: "degrade",
        reasonCode: "global_budget_degraded",
        resolvedModelClass: "standard",
      },
    },
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, () => {
      const decision = evaluateAiRequest({
        request: testCase.input,
        config,
        usage: testCase.usage,
      });
      expect({
        decision: decision.decision,
        resolvedModelClass: decision.resolvedModelClass,
        resolvedModel: decision.resolvedModel,
        reasonCode: decision.reasonCode,
      }).toMatchObject(testCase.snapshot);
    });
  }
});
