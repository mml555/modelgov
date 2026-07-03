import type { Pool } from "pg";

export interface OutboxEntry {
  id: number;
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
    id: number;
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

export async function markWebhookDelivered(pool: Pool, id: number): Promise<void> {
  await pool.query(
    `UPDATE webhook_outbox SET delivered_at = now(), last_error = NULL WHERE id = $1`,
    [id],
  );
}

export async function markWebhookFailed(
  pool: Pool,
  id: number,
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
