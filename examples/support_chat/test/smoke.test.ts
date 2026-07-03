import { describe, expect, it } from "vitest";
import { createModelgovClient } from "@modelgov/sdk";

describe("support-chat example client", () => {
  it("builds a client with baseUrl and apiKey", () => {
    const client = createModelgovClient({
      baseUrl: "http://localhost:3000",
      apiKey: "test-key",
    });
    expect(client).toBeDefined();
    expect(typeof client.chat).toBe("function");
  });

  it("maps API errors to typed exceptions", async () => {
    const client = createModelgovClient({
      baseUrl: "http://localhost:3000",
      apiKey: "test-key",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { code: "policy_blocked", message: "nope" } }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(
      client.chat({
        userId: "u1",
        userType: "logged_in",
        feature: "support_chat",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({ name: "PolicyBlockedError", status: 403 });
  });
});
