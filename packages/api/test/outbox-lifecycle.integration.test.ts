import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import {
  claimPendingWebhooks,
  enqueueWebhook,
  markWebhookDelivered,
  markWebhookFailed,
} from "../src/services/webhookOutbox";

const DATABASE_URL = process.env.DATABASE_URL;

// The claim/mark half of the outbox had no coverage: only enqueue and delivery
// were tested. The claim query's stated purpose is that two replicas can never
// deliver the same row (its `UPDATE ... RETURNING` replaces a `SELECT ... FOR
// UPDATE SKIP LOCKED` that released locks too early), and markWebhookFailed owns
// the retry backoff. Both are asserted here against the real table.
describe.skipIf(!DATABASE_URL)("webhook outbox lifecycle (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE webhook_outbox");
  });

  const enqueue = (overrides: Partial<Parameters<typeof enqueueWebhook>[1]> = {}) =>
    enqueueWebhook(pool, {
      eventType: "budget.alert",
      payload: { globalSpendUsd: 85 },
      destinationUrl: "https://hooks.example.com/budget",
      secret: "s3cret",
      ...overrides,
    });

  it("claims a pending row and maps every column to the entry shape", async () => {
    await enqueue();
    const claimed = await claimPendingWebhooks(pool);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      eventType: "budget.alert",
      payload: { globalSpendUsd: 85 },
      destinationUrl: "https://hooks.example.com/budget",
      secret: "s3cret",
      maxAttempts: 5,
    });
    // attempts is incremented AT claim time — markWebhookFailed relies on this.
    expect(claimed[0]!.attempts).toBe(1);
    // id is a bigserial: pg returns bigint as a STRING. Pinned because the
    // interface previously declared `number`, which no runtime value ever was.
    expect(typeof claimed[0]!.id).toBe("string");
  });

  it("maps a NULL secret to undefined, not null", async () => {
    // An unsigned webhook must skip the HMAC header; `null` would be truthy-checked
    // wrong downstream if it leaked through.
    await enqueue({ secret: undefined });
    const [entry] = await claimPendingWebhooks(pool);
    expect(entry!.secret).toBeUndefined();
  });

  it("does not re-claim a row already claimed (the 60s lease)", async () => {
    // This is the duplicate-POST guard: a second worker polling immediately must
    // come back empty rather than deliver the same payload again.
    await enqueue();
    expect(await claimPendingWebhooks(pool)).toHaveLength(1);
    expect(await claimPendingWebhooks(pool)).toHaveLength(0);
  });

  it("honors the limit and claims the oldest next_attempt_at first", async () => {
    await enqueue({ payload: { n: 1 } });
    await enqueue({ payload: { n: 2 } });
    await enqueue({ payload: { n: 3 } });

    // Give the rows DISTINCT due times, oldest first. Without this they share a
    // default now() and the test would pass on any two rows, proving nothing
    // about ordering — only that two distinct rows came back.
    const { rows: all } = await pool.query<{ id: string }>(
      "SELECT id FROM webhook_outbox ORDER BY id",
    );
    const ids = all.map((r) => r.id);
    for (const [i, id] of ids.entries()) {
      await pool.query(
        `UPDATE webhook_outbox SET next_attempt_at = now() - make_interval(secs => $2) WHERE id = $1`,
        [id, (ids.length - i) * 60],
      );
    }

    // Compare SETS: the claim is an `UPDATE ... RETURNING`, and Postgres gives
    // no ordering guarantee on returned rows — only the subquery's LIMIT/ORDER
    // BY decides WHICH rows are taken, which is what oldest-first means here.
    const first = await claimPendingWebhooks(pool, 2);
    expect([...first.map((e) => e.id)].sort()).toEqual([...ids.slice(0, 2)].sort());
    const rest = await claimPendingWebhooks(pool, 2);
    expect(rest.map((e) => e.id)).toEqual(ids.slice(2));
  });

  it("never claims a delivered row", async () => {
    await enqueue();
    const [entry] = await claimPendingWebhooks(pool);
    await markWebhookDelivered(pool, entry!.id);

    // Make it eligible by time; delivered_at must still exclude it.
    await pool.query("UPDATE webhook_outbox SET next_attempt_at = now() - interval '1 hour'");
    expect(await claimPendingWebhooks(pool)).toHaveLength(0);
  });

  it("markWebhookDelivered stamps delivered_at and clears the last error", async () => {
    await enqueue();
    const [entry] = await claimPendingWebhooks(pool);
    await markWebhookFailed(pool, entry!.id, "boom", entry!.attempts);
    await markWebhookDelivered(pool, entry!.id);

    const { rows } = await pool.query(
      "SELECT delivered_at, last_error FROM webhook_outbox WHERE id = $1",
      [entry!.id],
    );
    expect(rows[0].delivered_at).not.toBeNull();
    expect(rows[0].last_error).toBeNull();
  });

  it("markWebhookFailed records the error and backs off exponentially", async () => {
    await enqueue();
    const [entry] = await claimPendingWebhooks(pool);

    await markWebhookFailed(pool, entry!.id, "connect ECONNREFUSED", 3);
    const { rows } = await pool.query(
      `SELECT last_error,
              EXTRACT(EPOCH FROM (next_attempt_at - now())) AS delay_sec
         FROM webhook_outbox WHERE id = $1`,
      [entry!.id],
    );
    expect(rows[0].last_error).toBe("connect ECONNREFUSED");
    // 2**3 = 8s, replacing the 60s claim lease (so a retry is sooner, not later).
    expect(Number(rows[0].delay_sec)).toBeGreaterThan(5);
    expect(Number(rows[0].delay_sec)).toBeLessThan(12);
  });

  it("caps the backoff at 15 minutes for a long-failing endpoint", async () => {
    await enqueue();
    const [entry] = await claimPendingWebhooks(pool);

    // 2**30 seconds would be ~34 years out — the cap is what keeps the row retryable.
    await markWebhookFailed(pool, entry!.id, "still down", 30);
    const { rows } = await pool.query(
      `SELECT EXTRACT(EPOCH FROM (next_attempt_at - now())) AS delay_sec
         FROM webhook_outbox WHERE id = $1`,
      [entry!.id],
    );
    expect(Number(rows[0].delay_sec)).toBeGreaterThan(60 * 14);
    expect(Number(rows[0].delay_sec)).toBeLessThanOrEqual(60 * 15);
  });

  it("truncates a huge error message instead of failing the update", async () => {
    await enqueue();
    const [entry] = await claimPendingWebhooks(pool);

    await markWebhookFailed(pool, entry!.id, "x".repeat(5000), 1);
    const { rows } = await pool.query("SELECT last_error FROM webhook_outbox WHERE id = $1", [
      entry!.id,
    ]);
    expect(rows[0].last_error).toHaveLength(2000);
  });

  it("stops claiming once max_attempts is exhausted (dead-lettered)", async () => {
    await enqueue({ maxAttempts: 2 });

    const first = await claimPendingWebhooks(pool);
    await markWebhookFailed(pool, first[0]!.id, "1st", first[0]!.attempts);
    await pool.query("UPDATE webhook_outbox SET next_attempt_at = now()");

    const second = await claimPendingWebhooks(pool);
    expect(second).toHaveLength(1);
    expect(second[0]!.attempts).toBe(2);
    await markWebhookFailed(pool, second[0]!.id, "2nd", second[0]!.attempts);
    await pool.query("UPDATE webhook_outbox SET next_attempt_at = now()");

    // attempts (2) is no longer < max_attempts (2): the row is dead, not retried
    // forever. cleanupWebhookOutbox is what eventually removes it.
    expect(await claimPendingWebhooks(pool)).toHaveLength(0);
  });

  it("respects maxAttempts passed at enqueue time", async () => {
    await enqueue({ maxAttempts: 9 });
    const [entry] = await claimPendingWebhooks(pool);
    expect(entry!.maxAttempts).toBe(9);
  });
});
