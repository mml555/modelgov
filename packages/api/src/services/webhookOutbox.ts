import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import { assertPublicHttpUrl } from "../util/httpUrlGuard";

export interface OutboxEntry {
  /** bigserial — pg returns bigint as a string, so this is NOT a number. */
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  destinationUrl: string;
  secret?: string;
  attempts: number;
  maxAttempts: number;
}

export async function enqueueWebhook(
  pool: Pool,
  params: {
    eventType: string;
    payload: Record<string, unknown>;
    destinationUrl: string;
    secret?: string;
    maxAttempts?: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO webhook_outbox (event_type, payload, destination_url, secret, max_attempts)
     VALUES ($1, $2::jsonb, $3, $4, $5)`,
    [
      params.eventType,
      JSON.stringify(params.payload),
      params.destinationUrl,
      params.secret ?? null,
      params.maxAttempts ?? 5,
    ],
  );
}

export async function claimPendingWebhooks(
  pool: Pool,
  limit = 20,
): Promise<OutboxEntry[]> {
  // Atomically claim rows: a bare `SELECT ... FOR UPDATE SKIP LOCKED` releases
  // its locks the instant the statement ends, so in a multi-replica deployment
  // two workers could select and deliver the same row (duplicate POSTs). Claim
  // via `UPDATE ... RETURNING`, incrementing `attempts` and leasing the row 60s
  // into the future so concurrent workers skip it; if delivery crashes without
  // a mark, the lease expires and it retries (bounded by max_attempts).
  const { rows } = await pool.query(
    `UPDATE webhook_outbox
     SET attempts = attempts + 1,
         next_attempt_at = now() + interval '60 seconds'
     WHERE id IN (
       SELECT id FROM webhook_outbox
       WHERE delivered_at IS NULL
         AND attempts < max_attempts
         AND next_attempt_at <= now()
       ORDER BY next_attempt_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, event_type, payload, destination_url, secret, attempts, max_attempts`,
    [limit],
  );

  return (rows as Array<{
    id: string;
    event_type: string;
    payload: Record<string, unknown>;
    destination_url: string;
    secret: string | null;
    attempts: number;
    max_attempts: number;
  }>).map((r) => ({
    id: r.id,
    eventType: r.event_type,
    payload: r.payload,
    destinationUrl: r.destination_url,
    secret: r.secret ?? undefined,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
  }));
}

export async function markWebhookDelivered(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE webhook_outbox SET delivered_at = now(), last_error = NULL WHERE id = $1`,
    [id],
  );
}

/**
 * Deliver one claimed outbox row: HMAC-signed POST with a 10s timeout. Lives
 * here (not in a routes file) because it is the generic delivery sink — budget
 * alerts, a non-billing feature, flow through it too.
 */
export async function deliverOutboxWebhook(
  entry: {
    id: string;
    payload: Record<string, unknown>;
    destinationUrl: string;
    secret?: string;
    attempts: number;
  },
  fetchImpl: typeof fetch = fetch,
  opts: { allowPrivateHosts?: boolean } = {},
): Promise<void> {
  // Re-apply the SSRF host guard at the delivery sink. The only enqueue path
  // today (budget alerts) validates the URL at boot, but the sink must not trust
  // that: a future enqueue path, a tampered row, or a config change could put a
  // private/link-local destination in the outbox. Throwing here marks the row
  // failed (retried, then dead-lettered) instead of POSTing to an internal host.
  // allowPrivateHosts mirrors BUDGET_ALERT_WEBHOOK_ALLOW_PRIVATE so an operator
  // who deliberately points alerts at a private host is not blocked.
  const target = assertPublicHttpUrl(entry.destinationUrl, {
    allowPrivate: opts.allowPrivateHosts,
  });

  const json = JSON.stringify(entry.payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "modelgov/1.0",
  };
  if (entry.secret) {
    const digest = createHmac("sha256", entry.secret).update(json).digest("hex");
    headers["x-modelgov-signature"] = `sha256=${digest}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    // POST the guard-checked, normalized URL (target.href), NOT the raw string —
    // and refuse redirects. Following a 30x would let a validated public host
    // bounce the POST to an internal/link-local address (e.g. the cloud metadata
    // endpoint), bypassing the SSRF guard above, which only saw the first hop.
    const res = await fetchImpl(target.href, {
      method: "POST",
      headers,
      body: json,
      signal: controller.signal,
      redirect: "manual",
    });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      throw new Error("webhook endpoint attempted a redirect; refusing to follow (SSRF guard)");
    }
    if (!res.ok) {
      throw new Error(`webhook returned ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retention for terminal outbox rows. Delivered rows are kept for a debugging
 * window; rows that exhausted max_attempts (dead-lettered) are kept longer so
 * an operator can inspect/replay them, then dropped — without this the table
 * grows forever.
 */
export async function cleanupWebhookOutbox(
  pool: Pool,
  opts: { deliveredRetentionMs: number; deadRetentionMs: number },
  batch = 5000,
): Promise<number> {
  // Drain each class in a loop so a large backlog clears in one pass rather than
  // one batch per maintenance tick (the empty case still costs a single query).
  let delivered = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM webhook_outbox
       WHERE id IN (
         SELECT id FROM webhook_outbox
         WHERE delivered_at IS NOT NULL
           AND delivered_at < now() - ($1 || ' milliseconds')::interval
         LIMIT $2
       )`,
      [String(opts.deliveredRetentionMs), batch],
    );
    const n = rowCount ?? 0;
    delivered += n;
    if (n < batch) break;
  }
  let dead = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM webhook_outbox
       WHERE id IN (
         SELECT id FROM webhook_outbox
         WHERE delivered_at IS NULL
           AND attempts >= max_attempts
           AND created_at < now() - ($1 || ' milliseconds')::interval
         LIMIT $2
       )`,
      [String(opts.deadRetentionMs), batch],
    );
    const n = rowCount ?? 0;
    dead += n;
    if (n < batch) break;
  }
  return delivered + dead;
}

export async function markWebhookFailed(
  pool: Pool,
  id: string,
  error: string,
  attempts: number,
): Promise<void> {
  // attempts was already incremented at claim time; here we only record the
  // error and set the retry backoff (overriding the 60s claim lease).
  const delaySec = Math.min(60 * 15, 2 ** attempts);
  await pool.query(
    `UPDATE webhook_outbox
     SET last_error = $2,
         next_attempt_at = now() + ($3 || ' seconds')::interval
     WHERE id = $1`,
    [id, error.slice(0, 2000), String(delaySec)],
  );
}
