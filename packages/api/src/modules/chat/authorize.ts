import type { RequestContext } from "../../plugins/requestContext";
import type { ChatInput } from "./types";

export type ChatAuthResult =
  | { ok: true; value: ChatInput }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      details: Record<string, unknown>;
    };

/**
 * Enforce API-key scoping on a chat request BEFORE any budget/model work:
 * permission to create chats, project/environment binding, and user-type /
 * user-id allowlists. Returns the input with project/environment defaulted from
 * the key, or a typed denial the route maps to an error response.
 *
 * Kept out of the route handler so the route only wires HTTP <-> service and the
 * authorization rules are unit-testable in isolation.
 */
export function authorizeChatInput(
  ctx: RequestContext,
  body: ChatInput,
): ChatAuthResult {
  if (ctx.apiKeyName && !ctx.permissions?.includes("chat:create")) {
    return deny(403, "forbidden", "API key is not permitted to create chats");
  }
  if (ctx.projectId && body.projectId && body.projectId !== ctx.projectId) {
    return deny(403, "project_mismatch", "API key is not permitted for this project");
  }
  if (ctx.environment && body.environment && body.environment !== ctx.environment) {
    return deny(403, "environment_mismatch", "API key is not permitted for this environment");
  }
  if (ctx.allowedUserTypes?.length && !ctx.allowedUserTypes.includes(body.userType)) {
    return deny(403, "user_type_forbidden", "API key is not permitted for this user type");
  }
  if (ctx.allowedUserIds?.length && !ctx.allowedUserIds.includes(body.userId)) {
    return deny(403, "user_forbidden", "API key is not permitted for this user");
  }

  return {
    ok: true,
    value: {
      ...body,
      projectId: ctx.projectId ?? body.projectId,
      environment: ctx.environment ?? body.environment,
    },
  };
}

function deny(status: number, code: string, message: string): ChatAuthResult {
  return { ok: false, status, code, message, details: {} };
}
