import type { RequestContext } from "../../plugins/requestContext";
import {
  checkEnvironmentScope,
  checkProjectScope,
  checkUserIdAllowed,
  checkUserTypeAllowed,
  firstScopeDenial,
  mergeProjectEnvironment,
} from "../authz/scope";
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
  // The `ctx.principalName` guard is the unauthenticated-mode bypass: when the
  // server is built with allowUnauthenticated (tests/openapi export) no auth hook
  // runs, so there is no principal and permission enforcement is intentionally
  // skipped. In production auth always sets a non-empty name, so an authenticated
  // principal is always subject to this check (the check never fails open there).
  if (ctx.principalName && !ctx.permissions?.includes("chat:create")) {
    return deny(403, "forbidden", "API key is not permitted to create chats");
  }

  const denial = firstScopeDenial(
    checkProjectScope(ctx, body.projectId),
    checkEnvironmentScope(ctx, body.environment),
    checkUserTypeAllowed(ctx, body.userType),
    checkUserIdAllowed(ctx, body.userId),
  );
  if (denial) return denial;

  return { ok: true, value: mergeProjectEnvironment(ctx, body) };
}

function deny(status: number, code: string, message: string): ChatAuthResult {
  return { ok: false, status, code, message, details: {} };
}
