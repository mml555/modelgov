import type { ModelgovConfig } from "@modelgov/policy-engine";
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
import { resolveBudgetNodeId, useHierarchicalBudgets } from "./routing";
import { prepareStream, releaseStream, settleStream, settleStreamPartial } from "./stream";
import type { ChatInput, ChatResult, ChatServiceDeps } from "./types";
import type { TenantPolicyResolver } from "../policy/tenantResolver";
import type { BillingService } from "../billing/service";
import type { FastifyReply, FastifyRequest } from "fastify";

function withRequestPolicyMeta(
  deps: ChatRouteDeps,
  tenantId?: string,
): ChatRouteDeps["policyMeta"] {
  if (!tenantId) return deps.policyMeta;
  return { ...deps.policyMeta, tenantId };
}

function chatDepsForRequest(
  deps: ChatRouteDeps,
  request: FastifyRequest,
  log: FastifyReply["log"] | FastifyRequest["log"],
): ChatServiceDeps {
  return {
    ...deps,
    log,
    policyMeta: withRequestPolicyMeta(deps, request.ctx.tenantId),
  };
}

export interface ChatRouteDeps {
  config: ModelgovConfig;
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
  policyMeta?: { configHash?: string; policyVersion?: string; tenantId?: string };
  /**
   * When set (MULTI_TENANT_POLICY), the request is evaluated against its tenant's
   * active policy version instead of the boot config. Absent = single boot config.
   */
  tenantPolicy?: TenantPolicyResolver;
  billing?: BillingService;
  /**
   * Hard wall-clock cap on a single stream (ms), bounded below RESERVATION_STALE_MS
   * so a long stream can't outlive its reservation and be swept mid-flight.
   */
  streamMaxDurationMs?: number;
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

    // Per-tenant policy resolution (MULTI_TENANT_POLICY): evaluate this request
    // against its tenant's active config version + stamp its policy identity.
    // Absent resolver = the single boot config, unchanged.
    const rdeps: ChatRouteDeps = deps.tenantPolicy
      ? { ...deps, ...(await deps.tenantPolicy.resolve(request.ctx.tenantId)) }
      : deps;

    const leafNodeId = resolveBudgetNodeId(input, request.ctx);
    const hierarchical = useHierarchicalBudgets(rdeps.hierarchicalBudgets, leafNodeId);

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
      return streamChat(
        chatDepsForRequest(rdeps, request, request.log),
        input,
        request,
        reply,
        hierarchical ? leafNodeId : undefined,
      );
    }

    // Hierarchical budgets (flag + a budgetNodeId from the request or the key)
    // route to the node-tree path; otherwise the default flat path runs.
    const useHierarchical = hierarchical;
    const svc = chatDepsForRequest(rdeps, request, request.log);
    const run = (): Promise<ChatResult> =>
      useHierarchical
        ? handleChatHierarchical(svc, input, leafNodeId as string)
        : handleChat(svc, input);

    let result: ChatResult;
    if (idempotencyKey) {
      const outcome = await withIdempotency(
        deps.pool,
        {
          key: idempotencyKey,
          userId: input.userId,
          hash: requestHash(input),
          captureContent: deps.idempotencyCaptureContent ?? false,
          tenantId: request.ctx.tenantId,
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
        reply.header("x-modelgov-request-id", result.auditRequestId);
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
      reply.header("x-modelgov-request-id", result.body.requestId);
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
  leafNodeId?: string,
): Promise<void> {
  if (!deps.litellm.chatStream) {
    sendError(reply, 501, "not_implemented", {}, "Streaming is not supported by this deployment");
    return;
  }

  const prep = await prepareStream(deps, input, leafNodeId);
  if (!prep.ok) {
    sendError(reply, prep.status, prep.code, prep.details, prep.message, {
      ...(prep.policy ? { policy: prep.policy } : {}),
    });
    return;
  }
  const ctx = prep.ctx;

  const controller = new AbortController();
  // Single-winner guard for the terminal action (full settle, partial settle, or
  // release). JS is single-threaded, so this check-and-set is atomic between
  // awaits — whichever of the close handler, the duration cap, and the read loop
  // reaches it first owns settlement; the others no-op. Without it the success
  // path could settle a stream the close handler already partial-settled (double
  // audit row + double Stripe meter event).
  let finished = false;
  const claim = (): boolean => {
    if (finished) return false;
    finished = true;
    return true;
  };
  // Total characters streamed to the client so far — used to bill the tokens
  // actually produced if the stream is cut short (see settleStreamPartial).
  let outputChars = 0;
  const releaseOnce = async (): Promise<void> => {
    if (!claim()) return;
    await releaseStream(deps, ctx);
  };
  // A stream cut short after the first byte has real, provider-billed output.
  // Settle for what was produced instead of refunding the whole hold.
  const settlePartialOnce = async (
    outcome: "client_disconnect" | "stream_interrupted",
  ): Promise<void> => {
    if (!claim()) return;
    await settleStreamPartial(deps, ctx, outputChars, outcome);
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
    void settlePartialOnce("client_disconnect");
  };
  request.raw.on("close", onClose);

  // Hard wall-clock cap. A stream that runs longer than its reservation TTL would
  // be swept mid-flight (lease refunded) and then settle to a no-op — served free.
  // Aborting here makes the read loop throw into the catch below, which partial-
  // settles for what was produced before the reservation can go stale.
  const maxMs = deps.streamMaxDurationMs;
  const durationTimer =
    maxMs && maxMs > 0
      ? setTimeout(() => {
          if (finished) return;
          request.log.warn({ maxMs }, "stream exceeded max duration; aborting and settling");
          controller.abort();
        }, maxMs)
      : undefined;
  const clearDurationTimer = (): void => {
    if (durationTimer) clearTimeout(durationTimer);
  };

  try {
    let next = first;
    while (!next.done) {
      outputChars += next.value.delta.length;
      raw.write(`data: ${JSON.stringify({ delta: next.value.delta })}\n\n`);
      next = await gen.next();
    }
    const final = next.value;
    request.raw.off("close", onClose);
    clearDurationTimer();
    // If the close handler or the duration cap already claimed settlement, don't
    // settle again — that stream was cut short and is being partial-settled.
    if (!claim()) return;
    const requestId = await settleStream(deps, ctx, final, outputChars);
    raw.write(
      `data: ${JSON.stringify({
        done: true,
        model: final.model,
        usage: { inputTokens: final.inputTokens ?? null, outputTokens: final.outputTokens ?? null },
        requestId,
      })}\n\n`,
    );
    raw.write("data: [DONE]\n\n");
    raw.end();
  } catch (err) {
    request.raw.off("close", onClose);
    clearDurationTimer();
    await settlePartialOnce("stream_interrupted");
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
