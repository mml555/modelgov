import { createHmac } from "node:crypto";
import { parseConfigObject } from "@modelgov/policy-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import { createBillingService } from "../src/modules/billing/service";
import { topUpCreditsInTransaction } from "../src/modules/billing/repo";

// Stripe webhook + metered-flush behaviors, split out of billing.integration to
// keep each file under the modularity size limit. These call the billing service
// directly (no HTTP server) — signature-verified webhook handling, subscription
// lifecycle, currency/markup on Checkout top-ups, and meter poison-row handling.

const DATABASE_URL = process.env.DATABASE_URL;

const RAW_CONFIG = {
  project: { name: "billing-stripe-test", environment: "test" },
  budgets: {
    global: { monthly_usd: 100, hard_stop_at_percent: 100 },
    by_user_type: { logged_in: { daily_usd: 5, daily_requests: 100, models: ["cheap"] } },
  },
  features: { support_chat: { safety: "dev", model_class: "cheap", max_tokens: 500 } },
  model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
  safety: { preset: "dev" },
  billing: { provider: "stripe", mode: "hybrid" },
};

const config = parseConfigObject(RAW_CONFIG);

describe.skipIf(!DATABASE_URL)("billing stripe webhooks + meter flush (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE billing_accounts, meter_events, stripe_processed_events, billing_reservation_leases`,
    );
  });

  const signStripe = (secret: string, body: string): string => {
    const t = Math.floor(Date.now() / 1000);
    const digest = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    return `t=${t},v1=${digest}`;
  };

  it("applies the usd_per_credit sell rate to a raw amount_total checkout (M5)", async () => {
    const secret = "whsec_markup";
    const markupConfig = parseConfigObject({
      ...RAW_CONFIG,
      billing: { provider: "stripe", mode: "hybrid", stripe: { usd_per_credit: 0.02 } },
    });
    const svc = createBillingService(pool, { billing: markupConfig.billing, stripeWebhookSecret: secret })!;
    const body = JSON.stringify({
      id: "evt_markup",
      type: "checkout.session.completed",
      // $10.00 paid, no explicit credits_usd → converted at the 0.02 sell rate:
      // par (0.01) is 1:1, so 0.02 grants half → $5 of wallet credit.
      data: { object: { customer: "cus_m", metadata: { user_id: "u_m", tenant_id: "" }, amount_total: 1000, currency: "usd" } },
    });
    await svc.handleStripeWebhook(Buffer.from(body), signStripe(secret, body));
    expect((await svc.getBalance("", "u_m")).creditsUsd).toBeCloseTo(5, 6);
  });

  it("skips a non-USD checkout amount_total rather than crediting the wrong FX (M4)", async () => {
    const secret = "whsec_fx";
    const svc = createBillingService(pool, { billing: config.billing, stripeWebhookSecret: secret })!;
    const body = JSON.stringify({
      id: "evt_fx",
      type: "checkout.session.completed",
      data: { object: { customer: "cus_fx", metadata: { user_id: "u_fx", tenant_id: "" }, amount_total: 1000, currency: "eur" } },
    });
    await svc.handleStripeWebhook(Buffer.from(body), signStripe(secret, body));
    expect((await svc.getBalance("", "u_fx")).creditsUsd).toBeCloseTo(0, 6);
  });

  it("defers the credit until an async payment clears, then grants once (N1)", async () => {
    const secret = "whsec_async";
    const svc = createBillingService(pool, { billing: config.billing, stripeWebhookSecret: secret })!;
    // completed but payment_status "unpaid" (ACH not cleared) → no grant yet.
    const unpaid = JSON.stringify({
      id: "evt_async_pending",
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_async",
          payment_status: "unpaid",
          metadata: { user_id: "u_async", tenant_id: "", credits_usd: "7" },
        },
      },
    });
    await svc.handleStripeWebhook(Buffer.from(unpaid), signStripe(secret, unpaid));
    expect((await svc.getBalance("", "u_async")).creditsUsd).toBeCloseTo(0, 6);

    // Funds clear → async_payment_succeeded (payment_status "paid") → grant once.
    const cleared = JSON.stringify({
      id: "evt_async_cleared",
      type: "checkout.session.async_payment_succeeded",
      data: {
        object: {
          customer: "cus_async",
          payment_status: "paid",
          metadata: { user_id: "u_async", tenant_id: "", credits_usd: "7" },
        },
      },
    });
    await svc.handleStripeWebhook(Buffer.from(cleared), signStripe(secret, cleared));
    expect((await svc.getBalance("", "u_async")).creditsUsd).toBeCloseTo(7, 6);
  });

  it("does not collapse admin top-ups for different users sharing an idempotency key (N2)", async () => {
    const svc = createBillingService(pool, { billing: config.billing, stripeWebhookSecret: "whsec_x" })!;
    await svc.adminTopUp({ tenantId: "", userId: "u_a", creditsUsd: 3, idempotencyKey: "june" });
    await svc.adminTopUp({ tenantId: "", userId: "u_b", creditsUsd: 5, idempotencyKey: "june" });
    expect((await svc.getBalance("", "u_a")).creditsUsd).toBeCloseTo(3, 6);
    expect((await svc.getBalance("", "u_b")).creditsUsd).toBeCloseTo(5, 6);
  });

  it("downgrades user_type on customer.subscription.deleted (H3)", async () => {
    const secret = "whsec_subdel";
    const subConfig = parseConfigObject({
      ...RAW_CONFIG,
      billing: {
        provider: "stripe",
        mode: "hybrid",
        stripe: { plan_map: { price_pro: "paid_user" }, downgrade_user_type: "free_user" },
      },
    });
    const svc = createBillingService(pool, { billing: subConfig.billing, stripeWebhookSecret: secret })!;
    await topUpCreditsInTransaction(pool, { tenantId: "", userId: "u_sub", creditsUsd: 1, stripeCustomerId: "cus_sub" });

    const created = JSON.stringify({
      id: "evt_sub_created",
      type: "customer.subscription.created",
      data: { object: { customer: "cus_sub", status: "active", items: { data: [{ price: { id: "price_pro" } }] } } },
    });
    await svc.handleStripeWebhook(Buffer.from(created), signStripe(secret, created));
    expect((await svc.getBalance("", "u_sub")).userType).toBe("paid_user");

    const deleted = JSON.stringify({
      id: "evt_sub_deleted",
      type: "customer.subscription.deleted",
      data: { object: { customer: "cus_sub", status: "canceled", items: { data: [{ price: { id: "price_pro" } }] } } },
    });
    await svc.handleStripeWebhook(Buffer.from(deleted), signStripe(secret, deleted));
    expect((await svc.getBalance("", "u_sub")).userType).toBe("free_user");
  });

  it("ignores a stale redelivered subscription event (ordering guard, H4)", async () => {
    const secret = "whsec_order";
    const subConfig = parseConfigObject({
      ...RAW_CONFIG,
      billing: {
        provider: "stripe",
        mode: "hybrid",
        stripe: { plan_map: { price_pro: "paid_user" }, downgrade_user_type: "free_user" },
      },
    });
    const svc = createBillingService(pool, { billing: subConfig.billing, stripeWebhookSecret: secret })!;
    await topUpCreditsInTransaction(pool, { tenantId: "", userId: "u_ord", creditsUsd: 1, stripeCustomerId: "cus_ord" });

    // 1) active @ t=1000 → paid.
    const active = JSON.stringify({
      id: "evt_active",
      type: "customer.subscription.updated",
      created: 1000,
      data: { object: { customer: "cus_ord", status: "active", items: { data: [{ price: { id: "price_pro" } }] } } },
    });
    await svc.handleStripeWebhook(Buffer.from(active), signStripe(secret, active));
    expect((await svc.getBalance("", "u_ord")).userType).toBe("paid_user");

    // 2) deleted @ t=2000 → downgraded.
    const deleted = JSON.stringify({
      id: "evt_deleted",
      type: "customer.subscription.deleted",
      created: 2000,
      data: { object: { customer: "cus_ord", status: "canceled", items: { data: [{ price: { id: "price_pro" } }] } } },
    });
    await svc.handleStripeWebhook(Buffer.from(deleted), signStripe(secret, deleted));
    expect((await svc.getBalance("", "u_ord")).userType).toBe("free_user");

    // 3) Stripe RE-DELIVERS the stale active @ t=1000 (different event id, older
    //    created). It must be SKIPPED — a cancelled account must not re-upgrade.
    const staleActive = JSON.stringify({
      id: "evt_active_retry",
      type: "customer.subscription.updated",
      created: 1000,
      data: { object: { customer: "cus_ord", status: "active", items: { data: [{ price: { id: "price_pro" } }] } } },
    });
    await svc.handleStripeWebhook(Buffer.from(staleActive), signStripe(secret, staleActive));
    expect((await svc.getBalance("", "u_ord")).userType).toBe("free_user");
  });

  it("does not upgrade on an incomplete subscription (M3)", async () => {
    const secret = "whsec_incomplete";
    const subConfig = parseConfigObject({
      ...RAW_CONFIG,
      billing: {
        provider: "stripe",
        mode: "hybrid",
        stripe: { plan_map: { price_pro: "paid_user" }, downgrade_user_type: "free_user" },
      },
    });
    const svc = createBillingService(pool, { billing: subConfig.billing, stripeWebhookSecret: secret })!;
    await topUpCreditsInTransaction(pool, { tenantId: "", userId: "u_inc", creditsUsd: 1, stripeCustomerId: "cus_inc" });
    const body = JSON.stringify({
      id: "evt_sub_incomplete",
      type: "customer.subscription.updated",
      data: { object: { customer: "cus_inc", status: "incomplete", items: { data: [{ price: { id: "price_pro" } }] } } },
    });
    await svc.handleStripeWebhook(Buffer.from(body), signStripe(secret, body));
    // Non-active status → downgraded, never granted the paid tier on an unpaid sub.
    expect((await svc.getBalance("", "u_inc")).userType).toBe("free_user");
  });

  it("marks a meter row poison after a permanent Stripe failure and stops retrying (H2)", async () => {
    const meteredConfig = parseConfigObject({
      ...RAW_CONFIG,
      billing: {
        provider: "stripe",
        mode: "metered",
        stripe: { secret_key: "sk_test", meter_event_name: "modelgov_usage" },
      },
    });
    // Stripe returns 400 (e.g. "No such customer") → permanent, non-retryable.
    const failingFetch = (async () =>
      new Response("No such customer", { status: 400 })) as unknown as typeof fetch;
    const svc = createBillingService(pool, { billing: meteredConfig.billing, fetchImpl: failingFetch })!;
    // Account with a Stripe customer id so the row is "reportable" (not customer-less).
    await topUpCreditsInTransaction(pool, { tenantId: "", userId: "u_poison", creditsUsd: 0, stripeCustomerId: "cus_poison" });
    await svc.recordMeter({ requestId: "req_poison", tenantId: "", userId: "u_poison", feature: "f", costUsd: 0.02 });

    const reported = await svc.flushPendingMeters();
    expect(reported).toBe(0);
    const row = await pool.query(`SELECT attempts, reported_at FROM meter_events WHERE request_id = 'req_poison'`);
    expect(row.rows[0].reported_at).toBeNull();
    // A permanent failure jumps straight to the retry ceiling so it's skipped next time.
    expect(row.rows[0].attempts).toBeGreaterThanOrEqual(10);

    // Subsequent flush skips the poison row entirely — no newer usage is starved.
    await svc.recordMeter({ requestId: "req_fresh", tenantId: "", userId: "u_poison", feature: "f", costUsd: 0.03 });
    await svc.flushPendingMeters(); // fresh row is attempted (and also 400s here), poison row untouched
    const poison = await pool.query(`SELECT attempts FROM meter_events WHERE request_id = 'req_poison'`);
    expect(poison.rows[0].attempts).toBe(row.rows[0].attempts); // not retried again
  });
});
