import type { RequestContext } from "../../plugins/requestContext";
import type { ExplainInput } from "./types";

export type ExplainAuthResult =
  | { ok: true; value: ExplainInput }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      details: Record<string, unknown>;
    };

/**
 * Enforce API-key scoping on a dry-run explain request. Explain is allowed for
 * keys with either `chat:create` or `policy:explain`, then subject to the same
 * project/environment/user allowlists as chat. Returns the input with
 * project/environment defaulted from the key, or a typed denial.
 */
export function authorizeExplainInput(
  ctx: RequestContext,
  body: ExplainInput,
): ExplainAuthResult {
  const perms = ctx.permissions ?? ["chat:create"];
  if (ctx.apiKeyName && !perms.includes("chat:create") && !perms.includes("policy:explain")) {
    return deny(403, "forbidden", "API key is not permitted to explain policy");
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

function deny(status: number, code: string, message: string): ExplainAuthResult {
  return { ok: false, status, code, message, details: {} };
}
