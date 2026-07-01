import { describe, expect, it } from "vitest";
import { createRuntimeServices } from "../src/bootstrap";
import { parseConfigObject } from "@ai-guard/policy-engine";

const config = parseConfigObject({
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 100, hard_stop_at_percent: 100 },
    by_user_type: { logged_in: { daily_usd: 1, daily_requests: 10, models: ["cheap"] } },
  },
  features: { support_chat: { safety: "dev", model_class: "cheap", max_tokens: 100 } },
  model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
  safety: { preset: "dev" },
});

describe("createRuntimeServices production guard", () => {
  it("refuses dev Langfuse credentials when AI_GUARD_PRODUCTION=true", () => {
    expect(() =>
      createRuntimeServices(
        {
          LITELLM_BASE_URL: "http://localhost:4000",
          LANGFUSE_PUBLIC_KEY: "pk-lf-ai-guard-local",
          LANGFUSE_SECRET_KEY: "sk-lf-ai-guard-local",
          AI_GUARD_PRODUCTION: "true",
        } as never,
        config,
      ),
    ).toThrow(/dev-overlay defaults/);
  });
});
