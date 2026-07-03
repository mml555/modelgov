import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
    await pool.query("TRUNCATE budget_alert_sent");
  });

  it("POSTs webhook once per month window", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const webhook = {
      url: "https://hooks.example.com/budget",
      secret: "test-secret",
      fetchImpl: fetchImpl as typeof fetch,
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

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe("https://hooks.example.com/budget");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "x-modelgov-signature": expect.stringMatching(/^sha256=/),
    });
    const body = JSON.parse(String(init.body));
    expect(body.event).toBe("budget.alert");
    expect(body.scope).toBe("global_monthly");
    expect(body.windowStart).toBe("2026-06-01");
  });
});
