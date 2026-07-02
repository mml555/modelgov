/**
 * Integration guardrails for SDK callers. Ai-Guard budgets and policies key off
 * `userId` — it must be your app's stable internal id, not a raw session/JWT.
 */

const SESSION_LIKE_USER_ID = /^(eyJ[a-zA-Z0-9_-]{10,}|sess_|session_|token_)/i;

/** Returns true when userId looks like a session token rather than an app user id. */
export function looksLikeSessionToken(userId: string): boolean {
  if (userId.length > 256) return true;
  return SESSION_LIKE_USER_ID.test(userId);
}

/**
 * Warn when userId may be mis-integrated (session/JWT passed through). No-op when
 * `AI_GUARD_SDK_WARN_INTEGRATION=false` is set in the environment.
 */
export function warnUntrustedUserId(userId: string, field = "userId"): void {
  if (typeof process !== "undefined" && process.env?.AI_GUARD_SDK_WARN_INTEGRATION === "false") {
    return;
  }
  if (!looksLikeSessionToken(userId)) return;
  console.warn(
    `[ai-guard] ${field} looks like a session or OAuth token — pass your app's stable internal user id after authenticating the user. Ai-Guard does not verify app-level auth. See https://github.com/ai-guard/ai-guard/blob/main/docs/mental-model.md`,
  );
}
