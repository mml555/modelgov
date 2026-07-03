import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import { handleGlobalBudgetAlert } from "../src/modules/usage/budgetAlerts";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("budget alert webhooks (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE budget_alert_sent, webhook_outbox");
  });

  it("enqueues the budget-alert webhook once per month window", async () => {
    // Delivery is via the webhook outbox now (the maintenance sweep POSTs it),
    // so handleGlobalBudgetAlert enqueues rather than firing HTTP directly.
    const webhook = {
      url: "https://hooks.example.com/budget",
      secret: "test-secret",
    };
    const payload = {
      globalSpendUsd: 85,
      alertThresholdUsd: 80,
      alertAtPercent: 80,
      monthlyCapUsd: 100,
      now: new Date("2026-06-30T12:00:00Z"),
    };

    await handleGlobalBudgetAlert(pool, webhook, payload);
    await handleGlobalBudgetAlert(pool, webhook, payload);

    // Deduped by budget_alert_sent → enqueued exactly once for the window.
    const { rows } = await pool.query(
      "SELECT event_type, destination_url, payload FROM webhook_outbox WHERE event_type = 'budget.alert'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].destination_url).toBe("https://hooks.example.com/budget");
    const body = rows[0].payload as Record<string, unknown>;
    expect(body.event).toBe("budget.alert");
    expect(body.scope).toBe("global_monthly");
    expect(body.windowStart).toBe("2026-06-01");
  });
});
