import { createHmac } from "node:crypto";
import { parseConfigObject } from "@modelgov/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import { createBillingService } from "../src/modules/billing/service";
import {
  cleanupMeterEvents,
  cleanupStaleBillingLeases,
  cleanupStripeProcessedEvents,
  topUpCreditsInTransaction,
} from "../src/modules/billing/repo";
import { cleanupWebhookOutbox } from "../src/services/webhookOutbox";
import { settleBillingCredits } from "../src/modules/billing/settlement";
import {
  type LiteLLMChatResult,
  type LiteLLMClient,
} from "../src/services/litellm";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";

const DATABASE_URL = process.env.DATABASE_URL;

const RAW_CONFIG = {
  project: { name: "billing-test", environment: "test" },
  budgets: {
    global: { monthly_usd: 100, daily_usd: 10, hard_stop_at_percent: 100 },
    by_user_type: {
      logged_in: { daily_usd: 5, daily_requests: 100, models: ["cheap"] },
    },
  },
  features: {
    support_chat: { safety: "dev", model_class: "cheap", max_tokens: 500 },
  },
  model_classes: {
    cheap: { primary: "openai/gpt-4o-mini" },
  },
  safety: { preset: "dev" },
  billing: {
    provider: "stripe",
    mode: "hybrid",
    // Prepaid credits: no Stripe usage meter (meter_event_name alongside a credits
    // mode is rejected by config validation — it would double-bill). The wallet
    // debit is the charge; no meter_events rows are written in credits modes.
  },
};

const config = parseConfigObject(RAW_CONFIG);

function okResult(model: string): LiteLLMChatResult {
  return {
    content: `reply from ${model}`,
    model,
    actualCostUsd: 0.05,
    inputTokens: 12,
    outputTokens: 8,
    raw: {},
  };
}

const OPS_HEADERS = { authorization: "Bearer ops-key" };
const CHAT_HEADERS = { authorization: "Bearer chat-key" };

describe.skipIf(!DATABASE_URL)("billing + emergency (integration)", () => {
  let pool: Pool;
  let billing: NonNullable<ReturnType<typeof createBillingService>>;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
    billing = createBillingService(pool, { billing: config.billing })!;
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE budget_counters, request_logs, idempotency_keys,
       billing_accounts, meter_events, webhook_outbox, system_flags,
       stripe_processed_events, billing_reservation_leases`,
    );
  });

  function appWith(litellm: LiteLLMClient): FastifyInstance {
    return buildServer({
      config,
      pool,
      litellm,
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      billing,
      logger: false,
      apiKeys: [
        { name: "chat", key: "chat-key", permissions: ["chat:create"] },
        {
          name: "ops",
          key: "ops-key",
          permissions: ["chat:create", "usage:read", "billing:write", "policy:read", "policy:write"],
        },
      ],
    });
  }

  const postChat = (
    app: FastifyInstance,
    body: Record<string, unknown>,
    headers = CHAT_HEADERS,
  ) => app.inject({ method: "POST", url: "/v1/chat", payload: body, headers });

  it("tops up credits and returns balance", async () => {
    const app = appWith({ chat: async (p) => okResult(p.model) });

    const topUp = await app.inject({
      method: "POST",
      url: "/v1/admin/billing/top-up",
      headers: OPS_HEADERS,
      payload: { userId: "u1", creditsUsd: 2.5 },
    });
    expect(topUp.statusCode).toBe(200);
    expect(topUp.json().balance.creditsUsd).toBeCloseTo(2.5, 6);

    const balance = await app.inject({
      method: "GET",
      url: "/v1/users/u1/balance",
      headers: OPS_HEADERS,
    });
    expect(balance.statusCode).toBe(200);
    expect(balance.json().creditsAvailableUsd).toBeCloseTo(2.5, 6);
    expect(balance.json().mode).toBe("hybrid");
  });

  it("blocks chat with insufficient_credits when wallet is empty", async () => {
    const app = appWith({ chat: async (p) => okResult(p.model) });
    const res = await postChat(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "support_chat",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe("insufficient_credits");
    expect(res.json().error.details.reasonCode).toBe("insufficient_credits");
  });

  it("allows chat and debits credits on settle in hybrid mode", async () => {
    const app = appWith({ chat: async (p) => okResult(p.model) });
    await billing.adminTopUp({ tenantId: "", userId: "u1", creditsUsd: 1 });

    const res = await postChat(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "support_chat",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.statusCode).toBe(200);

    const account = await pool.query(
      `SELECT credits_usd::float8 AS credits_usd, credits_reserved_usd::float8 AS reserved
       FROM billing_accounts WHERE user_id = 'u1'`,
    );
    expect(Number(account.rows[0].credits_usd)).toBeCloseTo(0.95, 4);
    expect(Number(account.rows[0].reserved)).toBeCloseTo(0, 6);

    // Credits modes never write meter rows: the wallet debit IS the charge, and
    // a pending meter_events row could never be reported (no meter configured).
    const meters = await pool.query(
      `SELECT count(*)::int AS n FROM meter_events WHERE user_id = 'u1'`,
    );
    expect(meters.rows[0].n).toBe(0);
  });

  it("metered mode: records a meter event on settle and leaves the wallet untouched", async () => {
    const meteredConfig = parseConfigObject({
      ...RAW_CONFIG,
      billing: {
        provider: "stripe",
        mode: "metered",
        stripe: { secret_key: "sk_test", meter_event_name: "modelgov_usage" },
      },
    });
    const meteredBilling = createBillingService(pool, { billing: meteredConfig.billing })!;
    const app = buildServer({
      config: meteredConfig,
      pool,
      litellm: { chat: async (p) => okResult(p.model) },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      billing: meteredBilling,
      logger: false,
      apiKeys: [{ name: "chat", key: "chat-key", permissions: ["chat:create"] }],
    });

    const res = await postChat(app, {
      userId: "u_metered",
      userType: "logged_in",
      feature: "support_chat",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.statusCode).toBe(200);

    const meters = await pool.query(
      `SELECT cost_usd::float8 AS cost_usd, reported_at FROM meter_events WHERE user_id = 'u_metered'`,
    );
    expect(meters.rows).toHaveLength(1);
    expect(Number(meters.rows[0].cost_usd)).toBeGreaterThan(0);
    expect(meters.rows[0].reported_at).toBeNull(); // flushed later by maintenance

    // No wallet in metered mode: nothing reserved, nothing debited.
    const account = await pool.query(
      `SELECT count(*)::int AS n FROM billing_accounts WHERE user_id = 'u_metered'`,
    );
    expect(account.rows[0].n).toBe(0);
  });

  it("metered mode: settling after an audit-write failure still records a meter event", async () => {
    const meteredConfig = parseConfigObject({
      ...RAW_CONFIG,
      billing: {
        provider: "stripe",
        mode: "metered",
        stripe: { secret_key: "sk_test", meter_event_name: "modelgov_usage" },
      },
    });
    const meteredBilling = createBillingService(pool, { billing: meteredConfig.billing })!;
    // requestId "" is the audit-write-failure exit: the provider call ran (spend
    // is real) but no audit id exists. It must STILL be metered — a synthetic key
    // is minted — or the usage is silently unbilled.
    await settleBillingCredits(meteredBilling, undefined, {
      tenantId: "",
      userId: "u_noaudit",
      feature: "support_chat",
      reservedUsd: 0,
      actualCostUsd: 0.07,
      requestId: "",
    });
    const meters = await pool.query(
      `SELECT request_id, cost_usd::float8 AS cost_usd FROM meter_events WHERE user_id = 'u_noaudit'`,
    );
    expect(meters.rows).toHaveLength(1);
    expect(Number(meters.rows[0].cost_usd)).toBeCloseTo(0.07, 6);
    expect(meters.rows[0].request_id).toMatch(/^noaudit-/);
  });

  it("stale-lease sweep returns a stranded credit reservation to the wallet", async () => {
    // Simulates the crash/failed-settle case: reserve happens (lease written),
    // then neither settle nor release ever runs.
    await billing.adminTopUp({ tenantId: "", userId: "u_stranded", creditsUsd: 1 });
    const ok = await billing.reserveCredits("", "u_stranded", 0.4, "hold_stranded");
    expect(ok).toBe(true);

    let balance = await billing.getBalance("", "u_stranded");
    expect(balance.creditsReservedUsd).toBeCloseTo(0.4, 6);
    expect(balance.creditsAvailableUsd).toBeCloseTo(0.6, 6);

    // staleMs 0: everything is immediately stale.
    const released = await cleanupStaleBillingLeases(pool, 0);
    expect(released).toBe(1);

    balance = await billing.getBalance("", "u_stranded");
    expect(balance.creditsReservedUsd).toBeCloseTo(0, 6);
    expect(balance.creditsAvailableUsd).toBeCloseTo(1, 6);

    // A settle arriving AFTER its lease was swept must not double-book: the
    // hold's leases are gone, so the wallet is left untouched (undercount, never
    // double-charge — same trade-off as the internal ledger).
    await billing.settleCredits("", "u_stranded", 0.4, 0.4, "hold_stranded");
    balance = await billing.getBalance("", "u_stranded");
    expect(balance.creditsUsd).toBeCloseTo(1, 6);
    expect(balance.creditsReservedUsd).toBeCloseTo(0, 6);
  });

  it("settle with a hold id is idempotent under retry", async () => {
    await billing.adminTopUp({ tenantId: "", userId: "u_retry", creditsUsd: 1 });
    expect(await billing.reserveCredits("", "u_retry", 0.3, "hold_retry")).toBe(true);

    await billing.settleCredits("", "u_retry", 0.3, 0.1, "hold_retry");
    // Retry (e.g. caller retried after a transient error post-commit).
    await billing.settleCredits("", "u_retry", 0.3, 0.1, "hold_retry");

    const balance = await billing.getBalance("", "u_retry");
    expect(balance.creditsUsd).toBeCloseTo(0.9, 6); // debited once, not twice
    expect(balance.creditsReservedUsd).toBeCloseTo(0, 6);
  });

  it("retention sweeps prune terminal outbox/meter/stripe-event rows and keep live ones", async () => {
    // Old delivered + old dead-lettered + fresh pending outbox rows.
    await pool.query(
      `INSERT INTO webhook_outbox (event_type, payload, destination_url, attempts, max_attempts, delivered_at, created_at)
       VALUES ('t', '{}'::jsonb, 'https://example.com', 1, 5, now() - interval '40 days', now() - interval '41 days'),
              ('t', '{}'::jsonb, 'https://example.com', 5, 5, NULL, now() - interval '100 days'),
              ('t', '{}'::jsonb, 'https://example.com', 0, 5, NULL, now())`,
    );
    // Old reported + old never-reportable + fresh pending meter rows.
    await pool.query(
      `INSERT INTO meter_events (request_id, tenant_id, user_id, feature, cost_usd, reported_at, created_at)
       VALUES ('m_old_reported', '', 'u', 'f', 0.1, now() - interval '40 days', now() - interval '41 days'),
              ('m_abandoned',    '', 'u', 'f', 0.1, NULL, now() - interval '100 days'),
              ('m_pending',      '', 'u', 'f', 0.1, NULL, now())`,
    );
    await pool.query(
      `INSERT INTO stripe_processed_events (event_id, processed_at)
       VALUES ('evt_old', now() - interval '100 days'), ('evt_new', now())`,
    );

    const outboxRemoved = await cleanupWebhookOutbox(pool, {
      deliveredRetentionMs: 30 * 24 * 3600 * 1000,
      deadRetentionMs: 90 * 24 * 3600 * 1000,
    });
    expect(outboxRemoved).toBe(2);
    const meters = await cleanupMeterEvents(pool, {
      reportedRetentionMs: 30 * 24 * 3600 * 1000,
      abandonedRetentionMs: 90 * 24 * 3600 * 1000,
    });
    expect(meters).toEqual({ reported: 1, abandoned: 1 });
    expect(await cleanupStripeProcessedEvents(pool, 90 * 24 * 3600 * 1000)).toBe(1);

    const outboxLeft = await pool.query(`SELECT count(*)::int AS n FROM webhook_outbox`);
    expect(outboxLeft.rows[0].n).toBe(1); // the fresh pending row survives
    const metersLeft = await pool.query(`SELECT request_id FROM meter_events`);
    expect(metersLeft.rows).toEqual([{ request_id: "m_pending" }]);
    const eventsLeft = await pool.query(`SELECT event_id FROM stripe_processed_events`);
    expect(eventsLeft.rows).toEqual([{ event_id: "evt_new" }]);
  });

  it("keeps abandoned meter rows whose account was since linked to a Stripe customer", async () => {
    // Linked account: an old unreported row can still flush once picked up — it
    // must NOT be pruned as 'abandoned' (that would silently drop real usage).
    await pool.query(
      `INSERT INTO billing_accounts (tenant_id, user_id, stripe_customer_id, credits_usd)
       VALUES ('', 'u_linked', 'cus_linked', 0)`,
    );
    await pool.query(
      `INSERT INTO meter_events (request_id, tenant_id, user_id, feature, cost_usd, reported_at, created_at)
       VALUES ('m_linked_old', '', 'u_linked', 'f', 0.2, NULL, now() - interval '100 days'),
              ('m_unlinked_old', '', 'u_orphan', 'f', 0.2, NULL, now() - interval '100 days')`,
    );

    const meters = await cleanupMeterEvents(pool, {
      reportedRetentionMs: 30 * 24 * 3600 * 1000,
      abandonedRetentionMs: 90 * 24 * 3600 * 1000,
    });
    // Only the customer-less orphan is dropped; the linked row is preserved.
    expect(meters).toEqual({ reported: 0, abandoned: 1 });
    const left = await pool.query(`SELECT request_id FROM meter_events ORDER BY request_id`);
    expect(left.rows).toEqual([{ request_id: "m_linked_old" }]);
  });

  it("gates a zero-estimate reserve on a funded wallet (empty wallet is not free)", async () => {
    // A zero-rounded estimate skips the balance UPDATE; without the funded-wallet
    // gate an out-of-credit account would slip past and incur real (floored) spend.
    expect(await billing.reserveCredits("", "u_broke", 0, "hold_zero")).toBe(false);
    // No lease is written when the gate rejects.
    const leases = await pool.query(
      `SELECT count(*)::int AS n FROM billing_reservation_leases WHERE hold_id = 'hold_zero'`,
    );
    expect(leases.rows[0].n).toBe(0);

    // A funded wallet allows the zero-amount hold (and records its zero lease so
    // the lease-gated settle can book the real cost).
    await billing.adminTopUp({ tenantId: "", userId: "u_funded", creditsUsd: 1 });
    expect(await billing.reserveCredits("", "u_funded", 0, "hold_zero2")).toBe(true);
    const funded = await pool.query(
      `SELECT count(*)::int AS n FROM billing_reservation_leases WHERE hold_id = 'hold_zero2'`,
    );
    expect(funded.rows[0].n).toBe(1);
  });

  it("applies a Stripe top-up at most once per event id (replay-safe)", async () => {
    const first = await topUpCreditsInTransaction(pool, {
      tenantId: "",
      userId: "u_evt",
      creditsUsd: 3,
      stripeEventId: "evt_replay_1",
    });
    const replay = await topUpCreditsInTransaction(pool, {
      tenantId: "",
      userId: "u_evt",
      creditsUsd: 3,
      stripeEventId: "evt_replay_1",
    });
    expect(first).toBe(true);
    expect(replay).toBe(false);
    const balance = await billing.getBalance("", "u_evt");
    expect(balance.creditsUsd).toBeCloseTo(3, 6); // granted once, not doubled
  });

  it("rejects invalid stripe webhooks", async () => {
    const app = appWith({ chat: async (p) => okResult(p.model) });
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "stripe-signature": "t=1,v1=bad", "content-type": "application/json" },
      payload: { id: "evt_test", type: "ping", data: { object: {} } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("webhook_invalid");
  });

  const signStripe = (secret: string, body: string): string => {
    const t = Math.floor(Date.now() / 1000);
    const digest = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    return `t=${t},v1=${digest}`;
  };

  it("credits the buyer's own tenant when checkout omits tenant_id metadata", async () => {
    const secret = "whsec_tenant_fallback";
    const svc = createBillingService(pool, {
      billing: config.billing,
      stripeWebhookSecret: secret,
    })!;
    // A returning buyer already has an account under tenant "acme".
    await topUpCreditsInTransaction(pool, {
      tenantId: "acme",
      userId: "u_ck",
      creditsUsd: 1,
      stripeCustomerId: "cus_ck",
    });
    const body = JSON.stringify({
      id: "evt_ck_fallback",
      type: "checkout.session.completed",
      data: { object: { customer: "cus_ck", metadata: { user_id: "u_ck", credits_usd: "5" } } },
    });
    await svc.handleStripeWebhook(Buffer.from(body), signStripe(secret, body));

    // Resolved from the customer's existing account, not stranded in "".
    expect((await svc.getBalance("acme", "u_ck")).creditsUsd).toBeCloseTo(6, 6);
    expect((await svc.getBalance("", "u_ck")).creditsUsd).toBeCloseTo(0, 6);
  });

  it("honors explicit tenant_id metadata on checkout", async () => {
    const secret = "whsec_tenant_explicit";
    const svc = createBillingService(pool, {
      billing: config.billing,
      stripeWebhookSecret: secret,
    })!;
    const body = JSON.stringify({
      id: "evt_ck_explicit",
      type: "checkout.session.completed",
      data: {
        object: { customer: "cus_x", metadata: { user_id: "u_x", tenant_id: "beta", credits_usd: "4" } },
      },
    });
    await svc.handleStripeWebhook(Buffer.from(body), signStripe(secret, body));

    expect((await svc.getBalance("beta", "u_x")).creditsUsd).toBeCloseTo(4, 6);
    expect((await svc.getBalance("", "u_x")).creditsUsd).toBeCloseTo(0, 6);
  });

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
    const svc = createBillingService(pool, {
      billing: meteredConfig.billing,
      fetchImpl: failingFetch,
    })!;
    // Account with a Stripe customer id so the row is "reportable" (not customer-less).
    await topUpCreditsInTransaction(pool, {
      tenantId: "",
      userId: "u_poison",
      creditsUsd: 0,
      stripeCustomerId: "cus_poison",
    });
    await svc.recordMeter({ requestId: "req_poison", tenantId: "", userId: "u_poison", feature: "f", costUsd: 0.02 });

    const reported = await svc.flushPendingMeters();
    expect(reported).toBe(0);
    const row = await pool.query(
      `SELECT attempts, reported_at FROM meter_events WHERE request_id = 'req_poison'`,
    );
    expect(row.rows[0].reported_at).toBeNull();
    // A permanent failure jumps straight to the retry ceiling so it's skipped next time.
    expect(row.rows[0].attempts).toBeGreaterThanOrEqual(10);

    // Subsequent flush skips the poison row entirely — no newer usage is starved.
    await svc.recordMeter({ requestId: "req_fresh", tenantId: "", userId: "u_poison", feature: "f", costUsd: 0.03 });
    await svc.flushPendingMeters(); // fresh row is attempted (and also 400s here), poison row untouched
    const poison = await pool.query(
      `SELECT attempts FROM meter_events WHERE request_id = 'req_poison'`,
    );
    expect(poison.rows[0].attempts).toBe(row.rows[0].attempts); // not retried again
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

  it("pauses and resumes AI requests via emergency endpoints", async () => {
    const app = appWith({ chat: async (p) => okResult(p.model) });
    await billing.adminTopUp({ tenantId: "", userId: "u1", creditsUsd: 1 });

    const pause = await app.inject({
      method: "POST",
      url: "/v1/admin/emergency/pause",
      headers: OPS_HEADERS,
      payload: { reason: "test pause" },
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().paused).toBe(true);

    const blocked = await postChat(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "support_chat",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json().error.code).toBe("ai_requests_paused");

    const resume = await app.inject({
      method: "POST",
      url: "/v1/admin/emergency/resume",
      headers: OPS_HEADERS,
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().paused).toBe(false);

    const allowed = await postChat(app, {
      userId: "u1",
      userType: "logged_in",
      feature: "support_chat",
      messages: [{ role: "user", content: "hi again" }],
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("a tenant's pause never blocks another tenant (platform pause blocks all)", async () => {
    const { setEmergencyPause, getEmergencyPause } = await import("../src/modules/emergency/repo");

    // Tenant alpha pauses itself.
    await setEmergencyPause(pool, { paused: true, reason: "alpha incident", tenantId: "alpha" });
    expect((await getEmergencyPause(pool, "alpha")).paused).toBe(true);
    expect((await getEmergencyPause(pool, "alpha")).scope).toBe("tenant");
    // Tenant beta and untenanted callers are unaffected.
    expect((await getEmergencyPause(pool, "beta")).paused).toBe(false);
    expect((await getEmergencyPause(pool)).paused).toBe(false);

    // A platform-wide pause blocks every tenant.
    await setEmergencyPause(pool, { paused: true, reason: "platform incident" });
    expect((await getEmergencyPause(pool, "beta")).paused).toBe(true);
    expect((await getEmergencyPause(pool, "beta")).scope).toBe("platform");

    // Resuming the platform switch leaves alpha's own pause in force.
    await setEmergencyPause(pool, { paused: false });
    expect((await getEmergencyPause(pool, "alpha")).paused).toBe(true);
    expect((await getEmergencyPause(pool, "beta")).paused).toBe(false);
  });

  it("enforces global daily budget cap", async () => {
    // Seed today's AND tomorrow's UTC windows: the request below reads the
    // window from its own clock, so a run that straddles UTC midnight would
    // otherwise find an empty counter and flake.
    const now = Date.now();
    for (const day of [
      new Date(now).toISOString().slice(0, 10),
      new Date(now + 24 * 3600 * 1000).toISOString().slice(0, 10),
    ]) {
      await pool.query(
        `INSERT INTO budget_counters (scope, project_id, key, window_start, used_usd, reserved_usd, requests_used, tenant_id)
         VALUES ('global_daily', '', 'global', $1::date, 0.01, 0, 0, '')
         ON CONFLICT DO NOTHING`,
        [day],
      );
    }

    const tightConfig = parseConfigObject({
      ...RAW_CONFIG,
      budgets: {
        global: { monthly_usd: 100, daily_usd: 0.01, hard_stop_at_percent: 100 },
        by_user_type: RAW_CONFIG.budgets.by_user_type,
      },
      billing: { provider: "none", mode: "internal_only" },
    });
    const app = buildServer({
      config: tightConfig,
      pool,
      litellm: { chat: async (p) => okResult(p.model) },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      allowUnauthenticated: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        userId: "u1",
        userType: "logged_in",
        feature: "support_chat",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.reasonCode).toBe("global_daily_budget_exceeded");
  });
});
