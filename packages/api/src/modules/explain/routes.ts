import type { AiGuardConfig } from "@ai-guard/policy-engine";
import { PolicyConfigError } from "@ai-guard/policy-engine";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { sendError } from "../../errors";
import { errorJsonSchema } from "../chat/schemas";
import { authorizeExplainInput } from "./authorize";
import {
  explainBodyJsonSchema,
  explainBodySchema,
  explainSuccessJsonSchema,
} from "./schemas";
import { handleExplain } from "./service";

export interface ExplainRouteDeps {
  config: AiGuardConfig;
  pool: Pool;
}

export function registerExplainRoute(
  app: FastifyInstance,
  deps: ExplainRouteDeps,
): void {
  app.post("/v1/explain", {
    schema: {
      tags: ["explain"],
      description:
        "Dry-run policy evaluation. Returns the decision, resolved model, safety plan, " +
        "and budget snapshot without calling LiteLLM or reserving budget.",
      body: explainBodyJsonSchema,
      response: {
        200: explainSuccessJsonSchema,
        400: errorJsonSchema,
        401: errorJsonSchema,
        403: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = explainBodySchema.safeParse(request.body);
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

    const auth = authorizeExplainInput(request.ctx, parsed.data);
    if (!auth.ok) {
      return sendError(reply, auth.status, auth.code, auth.details, auth.message);
    }

    const result = await handleExplain(deps.config, deps.pool, auth.value);
    if (result instanceof PolicyConfigError) {
      return sendError(reply, 400, result.code, { detail: result.message }, result.message);
    }

    return reply.send(result);
  });
}
