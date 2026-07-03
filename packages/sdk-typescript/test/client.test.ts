import { describe, expect, it } from "vitest";
import {
  ModelgovError,
  createModelgovClient,
  PolicyBlockedError,
  SafetyBlockedError,
} from "../src/client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames: string[]): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const baseRequest = {
  userId: "u1",
  userType: "logged_in" as const,
  feature: "support_chat" as const,
  messages: [{ role: "user", content: "hi" }],
};

describe("createModelgovClient", () => {
  it("posts to /v1/chat and returns the parsed response", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    const fetchImpl: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({
        message: { role: "assistant", content: "hello" },
        model: "openai/gpt-4o-mini",
        decision: "allow",
      });
    };
    const client = createModelgovClient({ baseUrl: "http://api/", fetchImpl });
    const res = await client.chat(baseRequest);

    expect(capturedUrl).toBe("http://api/v1/chat");
    expect(capturedBody).toMatchObject({ feature: "support_chat" });
    expect(res.model).toBe("openai/gpt-4o-mini");
  });

  it("throws PolicyBlockedError on a 403 policy_blocked", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        {
          error: {
            code: "policy_blocked",
            message: "Policy blocked",
            details: { reason: "over budget" },
            requestId: "req_1",
          },
        },
        403,
      );
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    await expect(client.chat(baseRequest)).rejects.toBeInstanceOf(PolicyBlockedError);
  });

  it("throws SafetyBlockedError on a 403 safety_blocked", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        {
          error: {
            code: "safety_blocked",
            message: "Safety blocked",
            details: { reason: "prompt_injection" },
            requestId: "req_1",
          },
        },
        403,
      );
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    await expect(client.chat(baseRequest)).rejects.toBeInstanceOf(SafetyBlockedError);
  });

  it("exposes typed fields on the thrown error", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        {
          error: {
            code: "budget_exceeded",
            message: "over budget",
            details: {
              reasonCode: "daily_budget_exceeded",
              auditRequestId: "req_42",
              budgetRemaining: { userDailyUsd: 0, featureMonthlyUsd: null, globalMonthlyUsd: 5 },
              feature: "support_chat",
              userType: "logged_in",
              resolvedModelClass: "cheap",
            },
            requestId: "abc",
          },
        },
        403,
      );
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    try {
      await client.chat(baseRequest);
      throw new Error("expected throw");
    } catch (e) {
      const err = e as PolicyBlockedError;
      expect(err).toBeInstanceOf(PolicyBlockedError);
      expect(err.reasonCode).toBe("daily_budget_exceeded");
      expect(err.auditRequestId).toBe("req_42");
      expect(err.budgetRemaining?.globalMonthlyUsd).toBe(5);
      expect(err.feature).toBe("support_chat");
      expect(err.userType).toBe("logged_in");
      expect(err.resolvedModelClass).toBe("cheap");
    }
  });

  it("sends the Authorization header when an apiKey is set", async () => {
    let auth: string | null = null;
    const fetchImpl: typeof fetch = async (_url, init) => {
      auth = new Headers(init?.headers).get("authorization");
      return jsonResponse({ message: { role: "assistant", content: "x" } });
    };
    const client = createModelgovClient({ baseUrl: "http://api", apiKey: "secret", fetchImpl });
    await client.chat(baseRequest);
    expect(auth).toBe("Bearer secret");
  });

  it("aborts a request when the timeout expires", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      observedSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => {
          reject(observedSignal?.reason);
        });
      });
    };
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl, timeoutMs: null });

    await expect(client.chat(baseRequest, { timeoutMs: 1 })).rejects.toThrow(/timed out/);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("chatStream yields deltas and returns the terminal metadata", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return sseResponse([
        JSON.stringify({ delta: "Hel" }),
        JSON.stringify({ delta: "lo" }),
        JSON.stringify({ done: true, model: "m", usage: { inputTokens: 5, outputTokens: 2 }, requestId: "req_9" }),
        "[DONE]",
      ]);
    };
    const client = createModelgovClient({ baseUrl: "http://api", apiKey: "k", fetchImpl });

    const chunks: string[] = [];
    const it = client.chatStream(baseRequest);
    let result = await it.next();
    while (!result.done) {
      chunks.push(result.value);
      result = await it.next();
    }
    expect(capturedBody.stream).toBe(true);
    expect(chunks.join("")).toBe("Hello");
    expect(result.value?.requestId).toBe("req_9");
  });

  it("chatStream throws typed errors before streaming begins", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ error: { code: "budget_exceeded", message: "x", details: {}, requestId: "r" } }, 403);
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    const it = client.chatStream(baseRequest);
    await expect(it.next()).rejects.toBeInstanceOf(PolicyBlockedError);
  });

  it("chatStream surfaces the streaming_unsupported 400 as ModelgovError", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ error: { code: "streaming_unsupported", message: "x", details: {}, requestId: "r" } }, 400);
    const client = createModelgovClient({ baseUrl: "http://api", fetchImpl });
    const it = client.chatStream(baseRequest);
    await expect(it.next()).rejects.toBeInstanceOf(ModelgovError);
  });

  it("posts to /v1/explain and returns the parsed response", async () => {
    let capturedUrl = "";
    const fetchImpl: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return jsonResponse({
        decision: "block",
        summary: "Decision: block",
        wouldCallModel: false,
      });
    };
    const client = createModelgovClient({ baseUrl: "http://api/", fetchImpl });
    const res = await client.explain({
      userId: "u1",
      userType: "logged_in",
      feature: "support_chat",
      modelClass: "premium",
    });

    expect(capturedUrl).toBe("http://api/v1/explain");
    expect(res.decision).toBe("block");
  });
});
