import type { AiGuardConfig } from "@ai-guard/policy-engine";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { sendError } from "../../errors";
import type { LiteLLMClient } from "../../services/litellm";
import type { Observability } from "../../services/observability";
import type { SafetyGuard } from "../../services/safety";
import type { BudgetAlertWebhookConfig } from "../usage/budgetAlerts";
import { requestHash, withIdempotency } from "../idempotency/service";
import { authorizeChatInput } from "./authorize";
import { chatBodyJsonSchema, chatBodySchema, chatSuccessJsonSchema, errorJsonSchema } from "./schemas";
import { handleChat } from "./service";
import { handleChatHierarchical } from "./hierarchical";
import { prepareStream, releaseStream, settleStream } from "./stream";
import type { ChatInput, ChatResult, ChatServiceDeps } from "./types";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface ChatRouteDeps {
  config: AiGuardConfig;
  pool: Pool;
  litellm: LiteLLMClient;
  safety: SafetyGuard;
  observability: Observability;
  budgetAlert?: BudgetAlertWebhookConfig;
  /** When false, idempotency replays omit model completion text at rest. */
  idempotencyCaptureContent?: boolean;
  /** Opt-in hierarchical (node-tree) budgets for requests carrying a budgetNodeId. */
  hierarchicalBudgets?: boolean;
  /** Config identity stamped on every request log. */
  policyMeta?: { configHash?: string; policyVersion?: string };
}

export function registerChatRoute(
  app: FastifyInstance,
  deps: ChatRouteDeps,
): void {
  app.post("/v1/chat", {
    schema: {
      tags: ["chat"],
      body: chatBodyJsonSchema,
      response: {
        200: chatSuccessJsonSchema,
        400: errorJsonSchema,
        401: errorJsonSchema,
        403: errorJsonSchema,
        409: errorJsonSchema,
        422: errorJsonSchema,
        502: errorJsonSchema,
        503: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = chatBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        "invalid_request",
        {
          detail: parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        },
      );
    }

    const auth = authorizeChatInput(request.ctx, parsed.data as ChatInput);
    if (!auth.ok) {
      return sendError(reply, auth.status, auth.code, auth.details, auth.message);
    }
    const input = auth.value;
    const rawKey = request.headers["idempotency-key"];
    const idempotencyKey = readIdempotencyKey(rawKey);

    if (input.stream) {
      if (idempotencyKey) {
        return sendError(
          reply,
          400,
          "idempotency_not_supported",
          {},
          "Idempotency-Key is not supported with stream: true",
        );
      }
      return streamChat({ ...deps, log: request.log }, input, request, reply);
    }

    // Hierarchical budgets (flag + a budgetNodeId from the request or the key)
    // route to the node-tree path; otherwise the default flat path runs.
    const leafNodeId = input.budgetNodeId ?? request.ctx.budgetNodeId;
    const useHierarchical = Boolean(deps.hierarchicalBudgets && leafNodeId);
    const run = (): Promise<ChatResult> =>
      useHierarchical
        ? handleChatHierarchical({ ...deps, log: request.log }, input, leafNodeId as string)
        : handleChat({ ...deps, log: request.log }, input);

    let result: ChatResult;
    if (idempotencyKey) {
      const outcome = await withIdempotency(
        deps.pool,
        {
          key: idempotencyKey,
          userId: input.userId,
          hash: requestHash(input),
          captureContent: deps.idempotencyCaptureContent ?? false,
        },
        run,
      );
      result = outcome.result;
      reply.header("x-idempotent-replay", outcome.replayed ? "true" : "false");
    } else {
      result = await run();
    }

    if (!result.ok) {
      if (result.auditRequestId) {
        reply.header("x-ai-guard-request-id", result.auditRequestId);
      }
      return sendError(
        reply,
        result.status,
        result.code,
        result.details,
        result.message,
        {
          ...(result.policy ? { policy: result.policy } : {}),
          ...(result.auditRequestId ? { auditRequestId: result.auditRequestId } : {}),
        },
      );
    }

    if (result.body.requestId) {
      reply.header("x-ai-guard-request-id", result.body.requestId);
    }
    return reply.code(200).send(result.body);
  });
}

/**
 * Server-Sent Events streaming path. Runs all pre-call gates (which can still
 * fail as normal JSON errors), pulls the first chunk BEFORE committing a 200 so
 * a pre-first-byte provider failure returns a real HTTP error, then streams
 * `data:` frames and settles cost when the stream completes. Client disconnect
 * aborts the upstream and releases the reservation.
 */
async function streamChat(
  deps: ChatServiceDeps,
  input: ChatInput,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!deps.litellm.chatStream) {
    sendError(reply, 501, "not_implemented", {}, "Streaming is not supported by this deployment");
    return;
  }

  const prep = await prepareStream(deps, input);
  if (!prep.ok) {
    sendError(reply, prep.status, prep.code, prep.details, prep.message, {
      ...(prep.policy ? { policy: prep.policy } : {}),
    });
    return;
  }
  const ctx = prep.ctx;

  const controller = new AbortController();
  let finished = false;
  const releaseOnce = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    await releaseStream(deps, ctx);
  };

  const gen = deps.litellm.chatStream({
    model: ctx.decision.resolvedModel,
    messages: ctx.messages,
    maxTokens: ctx.decision.maxOutputTokens,
    temperature: ctx.temperature,
    signal: controller.signal,
  });

  // Pull the first event before committing headers: a connection/5xx failure
  // here is still a normal HTTP error (no SSE started, budget released).
  let first: IteratorResult<{ delta: string }, import("../../services/litellm").LiteLLMStreamFinal>;
  try {
    first = await gen.next();
  } catch (err) {
    await releaseOnce();
    request.log.error({ err }, "stream provider failure before first token");
    sendError(reply, 502, "provider_unavailable", {}, "Provider unavailable");
    return;
  }

  // Commit the SSE response, preserving the security headers already staged on
  // the reply by the onRequest hook.
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    ...(reply.getHeaders() as Record<string, string>),
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const onClose = (): void => {
    if (finished) return;
    controller.abort();
    void releaseOnce();
  };
  request.raw.on("close", onClose);

  try {
    let next = first;
    while (!next.done) {
      raw.write(`data: ${JSON.stringify({ delta: next.value.delta })}\n\n`);
      next = await gen.next();
    }
    const final = next.value;
    finished = true; // settled below owns the reservation now
    request.raw.off("close", onClose);
    const requestId = await settleStream(deps, ctx, final);
    raw.write(
      `data: ${JSON.stringify({
        done: true,
        model: final.model,
        usage: { inputTokens: final.inputTokens ?? null, outputTokens: final.outputTokens ?? null },
        requestId: requestId ?? "req_unknown",
      })}\n\n`,
    );
    raw.write("data: [DONE]\n\n");
    raw.end();
  } catch (err) {
    request.raw.off("close", onClose);
    await releaseOnce();
    request.log.error({ err }, "stream failed after first token");
    if (!raw.writableEnded) {
      raw.write(
        `event: error\ndata: ${JSON.stringify({ code: "provider_unavailable", message: "Stream interrupted" })}\n\n`,
      );
      raw.end();
    }
  }
}

function readIdempotencyKey(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 255) return null;
  return trimmed;
}
