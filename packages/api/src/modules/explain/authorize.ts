import type { RequestContext } from "../../plugins/requestContext";
import {
  checkEnvironmentScope,
  checkProjectScope,
  checkUserIdAllowed,
  checkUserTypeAllowed,
  firstScopeDenial,
  mergeProjectEnvironment,
} from "../authz/scope";
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

  const denial = firstScopeDenial(
    checkProjectScope(ctx, body.projectId),
    checkEnvironmentScope(ctx, body.environment),
    checkUserTypeAllowed(ctx, body.userType),
    checkUserIdAllowed(ctx, body.userId),
  );
  if (denial) return denial;

  return { ok: true, value: mergeProjectEnvironment(ctx, body) };
}

function deny(status: number, code: string, message: string): ExplainAuthResult {
  return { ok: false, status, code, message, details: {} };
}
