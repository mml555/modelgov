/**
 * Recognize "the database is unreachable" so it can be reported as a RETRYABLE
 * 503 instead of a generic 500.
 *
 * Why it matters in production: a Postgres restart/failover is transient and
 * safe to retry, but `500 internal_error` tells a well-behaved client NOT to
 * retry and tells on-call they are looking at a code defect. The gateway already
 * models its other hard dependency this way — Presidio down returns
 * `503 safety_unavailable` — so the database, which is the harder dependency,
 * should not be the odd one out.
 *
 * Deliberately narrow: only connection-level failures. A constraint violation,
 * a syntax error, or a statement timeout is OUR bug or a real query problem and
 * must keep surfacing as 500 — turning those into "retry later" would hide them.
 */

/** pg SQLSTATEs that mean the connection/server went away, not a bad query. */
const CONNECTION_SQLSTATES = new Set([
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "57P01", // admin_shutdown — server restarting
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now — server starting up
]);

/** Node socket-level codes for "nothing listening / link died". */
const CONNECTION_ERRNOS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);

/**
 * node-pg surfaces some failures as a plain Error with only a message — notably
 * pool checkout timeouts and a server that closed the socket mid-query.
 */
const CONNECTION_MESSAGES = [
  "connection terminated",
  "connection ended unexpectedly",
  "timeout exceeded when trying to connect",
  "client has encountered a connection error",
  "server closed the connection unexpectedly",
  "terminating connection due to administrator command",
];

export function isDatabaseUnavailableError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };

  const code = typeof e.code === "string" ? e.code : undefined;
  if (code && (CONNECTION_SQLSTATES.has(code) || CONNECTION_ERRNOS.has(code))) return true;

  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (message && CONNECTION_MESSAGES.some((m) => message.includes(m))) return true;

  // Pool/driver errors often wrap the socket error; check one level down.
  if (e.cause != null && e.cause !== err) return isDatabaseUnavailableError(e.cause);

  return false;
}
