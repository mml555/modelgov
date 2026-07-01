import { parseConfigObject } from "@ai-guard/policy-engine";
import { describe, expect, it } from "vitest";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";
import { mockPool } from "./mockPool";

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

function app() {
  return buildServer({
    config,
    pool: mockPool() as never,
    litellm: { chat: async () => ({ content: "ok", model: "m", actualCostUsd: 0, raw: {} }) },
    safety: new NoopGuard(),
    observability: new NoopObservability(),
    logger: false,
    apiKey: "secret",
  });
}

// Adversarial / malformed payloads for /v1/chat. None should ever crash the
// server (500) — the schema + handler must reject with a structured 4xx.
const FUZZ_PAYLOADS: unknown[] = [
  {},
  null,
  [],
  "not-an-object",
  42,
  { userId: "u" },
  { userId: "", userType: "", feature: "", messages: [] },
  { userId: "u", userType: "logged_in", feature: "support_chat", messages: [] },
  { userId: "u", userType: "logged_in", feature: "support_chat", messages: [{ role: "bad", content: "x" }] },
  { userId: "u", userType: "logged_in", feature: "support_chat", messages: [{ role: "user" }] },
  { userId: "u", userType: "logged_in", feature: "UNKNOWN", messages: [{ role: "user", content: "hi" }] },
  { userId: 123, userType: true, feature: {}, messages: "no" },
  { userId: "u", userType: "logged_in", feature: "support_chat", messages: [{ role: "user", content: "x" }], temperature: 99 },
  { userId: "u", userType: "logged_in", feature: "support_chat", messages: [{ role: "user", content: "x" }], stream: "yes" },
  { userId: "u".repeat(100000), userType: "logged_in", feature: "support_chat", messages: [{ role: "user", content: "x" }] },
  { userId: "u", userType: "logged_in", feature: "support_chat", messages: Array(1000).fill({ role: "user", content: "x" }) },
  { userId: "u", userType: "logged_in", feature: "support_chat", messages: [{ role: "user", content: "x" }], metadata: { __proto__: { polluted: true } } },
];

describe("chat input fuzzing", () => {
  it("never 500s or crashes on malformed payloads (always a structured error)", async () => {
    const server = app();
    for (const payload of FUZZ_PAYLOADS) {
      const res = await server.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        payload: JSON.stringify(payload),
      });
      const label = `payload ${JSON.stringify(payload)?.slice(0, 60)}`;
      // Invariant: never a 500/crash on caller-controlled input.
      expect(res.statusCode, label).toBeLessThan(500);
      // Any non-2xx must be a structured error envelope (not empty/HTML).
      if (res.statusCode >= 300) {
        expect(res.json(), label).toHaveProperty("error.code");
      }
    }
  });

  it("does not pollute Object.prototype via metadata", async () => {
    await app().inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      payload: JSON.stringify({
        userId: "u",
        userType: "logged_in",
        feature: "support_chat",
        messages: [{ role: "user", content: "x" }],
        metadata: JSON.parse('{"__proto__":{"polluted":true}}'),
      }),
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
