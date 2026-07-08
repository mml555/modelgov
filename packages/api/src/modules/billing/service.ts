import type { BillingMode } from "@modelgov/policy-engine";
import { roundUsd } from "@modelgov/policy-engine";
import type { Pool } from "pg";

// Par sell rate: at usd_per_credit === PAR, $1 of real money paid grants $1 of
// wallet credit (1:1, the default and the pre-existing behavior). A higher
// usd_per_credit sells each credit for more real money, so the same payment
// funds proportionally less wallet credit — that spread is the operator's markup.
const PAR_USD_PER_CREDIT = 0.01;
import {
  applySubscriptionUserType,
  findAccountByStripeCustomer,
  getBillingAccount,
  listPendingMeterEvents,
  markMeterReported,
  MAX_METER_ATTEMPTS,
  recordMeterEvent,
  recordMeterFailure,
  releaseCredits,
  reserveCredits,
  settleCredits,
  topUpCreditsInTransaction,
} from "./repo";
import {
  createStripeMeterEvent,
  verifyStripeWebhookSignature,
  type StripeCheckoutSession,
  type StripeEvent,
  type StripeInvoice,
  type StripeSubscription,
} from "./stripe";
import { mapWithConcurrency } from "../../util/concurrency";
import type { BillingBalance, BillingServiceConfig } from "./types";

export interface BillingService {
  readonly enabled: boolean;
  readonly mode: BillingMode;
  usesCredits(): boolean;
  /** True when usage is invoiced via a Stripe Billing Meter (mode "metered"). */
  usesMeter(): boolean;
  getBalance(tenantId: string, userId: string): Promise<BillingBalance>;
  checkCredits(
    tenantId: string,
    userId: string,
    estimatedUsd: number,
  ): Promise<{ ok: true; availableUsd: number } | { ok: false; availableUsd: number }>;
  /** holdId groups a request's leases so a crashed request can be swept. */
  reserveCredits(
    tenantId: string,
    userId: string,
    amountUsd: number,
    holdId?: string,
  ): Promise<boolean>;
  releaseCredits(
    tenantId: string,
    userId: string,
    amountUsd: number,
    holdId?: string,
  ): Promise<void>;
  settleCredits(
    tenantId: string,
    userId: string,
    reservedUsd: number,
    actualUsd: number,
    holdId?: string,
  ): Promise<void>;
  recordMeter(
    params: {
      requestId: string;
      tenantId: string;
      userId: string;
      feature: string;
      costUsd: number;
    },
  ): Promise<void>;
  flushPendingMeters(log?: {
    error(obj: unknown, msg: string): void;
    warn(obj: unknown, msg: string): void;
  }): Promise<number>;
  handleStripeWebhook(
    rawBody: Buffer,
    signature: string | undefined,
    log?: { warn(obj: unknown, msg: string): void },
  ): Promise<void>;
  adminTopUp(params: {
    tenantId: string;
    userId: string;
    creditsUsd: number;
    stripeCustomerId?: string;
    userType?: string;
    /** When set, the grant is applied at most once for this key (replay-safe). */
    idempotencyKey?: string;
  }): Promise<void>;
}

export function createBillingService(
  pool: Pool,
  opts: BillingServiceConfig,
): BillingService | undefined {
  const billing = opts.billing;
  if (!billing || billing.provider === "none" || billing.mode === "internal_only") {
    return undefined;
  }

  const stripeSecret = opts.stripeSecretKey ?? billing.stripe?.secretKey;
  const stripeWebhookSecret = opts.stripeWebhookSecret ?? billing.stripe?.webhookSecret;
  const planMap = billing.stripe?.planMap ?? {};
  const usdPerCredit = billing.stripe?.usdPerCredit ?? 0.01;
  const meterEventName = billing.stripe?.meterEventName;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const usesCredits = billing.mode === "hybrid" || billing.mode === "credits_only";

  // Defense in depth (config validation already enforces both): prepaid credits
  // and a Stripe usage meter must never coexist — the wallet debit and the
  // metered invoice would charge the same usage twice. Conversely, metered mode
  // has no other way to bill usage, so the meter event name is mandatory there.
  if (usesCredits && meterEventName) {
    throw new Error(
      `billing.mode "${billing.mode}" bills usage by debiting the prepaid credit wallet ` +
        "and cannot be combined with a Stripe usage meter (stripe.meterEventName) — the " +
        'same usage would be invoiced a second time. Remove stripe.meterEventName, or switch to mode "metered".',
    );
  }
  if (billing.mode === "metered" && !meterEventName) {
    throw new Error(
      'billing.mode "metered" requires stripe.meterEventName — usage is billed by reporting it to that Stripe Billing Meter.',
    );
  }
  if (billing.mode === "metered" && !stripeSecret) {
    // Without a Stripe secret the meter flush no-ops, so metered usage is
    // recorded, never reported, then pruned as "abandoned" — silently unbilled.
    // Fail fast instead of losing revenue.
    throw new Error(
      'billing.mode "metered" requires a Stripe secret key (stripe.secretKey / STRIPE_SECRET_KEY) — usage is billed by reporting meter events to Stripe, which cannot happen without it.',
    );
  }

  return {
    enabled: true,
    mode: billing.mode,
    usesCredits() {
      return usesCredits;
    },
    usesMeter() {
      return Boolean(meterEventName);
    },

    async getBalance(tenantId, userId) {
      const account = await getBillingAccount(pool, tenantId, userId);
      const creditsUsd = account?.creditsUsd ?? 0;
      const creditsReservedUsd = account?.creditsReservedUsd ?? 0;
      return {
        userId,
        creditsUsd,
        creditsReservedUsd,
        creditsAvailableUsd: Math.max(creditsUsd - creditsReservedUsd, 0),
        userType: account?.userType ?? null,
        stripeCustomerId: account?.stripeCustomerId ?? null,
        mode: billing.mode,
      };
    },

    async checkCredits(tenantId, userId, estimatedUsd) {
      const balance = await this.getBalance(tenantId, userId);
      if (balance.creditsAvailableUsd >= estimatedUsd) {
        return { ok: true, availableUsd: balance.creditsAvailableUsd };
      }
      return { ok: false, availableUsd: balance.creditsAvailableUsd };
    },

    async reserveCredits(tenantId, userId, amountUsd, holdId) {
      const amount = Math.max(amountUsd, 0);
      if (amount <= 0) {
        // Without a hold a zero-amount reserve records nothing and trivially
        // succeeds. With a hold the repo still writes the (zero) lease so the
        // lease-gated settle can book the actual cost — but the zero amount skips
        // the balance UPDATE, so an out-of-credit wallet would slip past the gate
        // and later be debited (floored at 0) for real spend. Gate it: require a
        // funded wallet, so an empty account still gets a 402 instead of free use.
        if (!holdId) return true;
        const account = await getBillingAccount(pool, tenantId, userId);
        const available = Math.max(
          (account?.creditsUsd ?? 0) - (account?.creditsReservedUsd ?? 0),
          0,
        );
        if (available <= 0) return false;
      }
      return reserveCredits(pool, { tenantId, userId, amountUsd: amount, holdId });
    },

    releaseCredits(tenantId, userId, amountUsd, holdId) {
      // With a holdId even a zero-amount release must reach the repo: reserve
      // recorded a (possibly zero-amount) lease, and only deleting it cleans the
      // hold — otherwise the lease lingers until the stale-lease sweep.
      if (amountUsd <= 0 && !holdId) return Promise.resolve();
      return releaseCredits(pool, { tenantId, userId, amountUsd: Math.max(amountUsd, 0), holdId });
    },

    settleCredits(tenantId, userId, reservedUsd, actualUsd, holdId) {
      return settleCredits(pool, { tenantId, userId, reservedUsd, actualUsd, holdId });
    },

    async recordMeter(params) {
      if (params.costUsd <= 0) return;
      // The meter_events row IS the billing record for metered mode, so a failed
      // insert here loses billable usage (there is no upstream retry). Retry a
      // transient failure a few times before surfacing it to the caller (which
      // logs). ON CONFLICT (request_id) DO NOTHING keeps retries idempotent.
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        const client = await pool.connect();
        try {
          await recordMeterEvent(client, params);
          return;
        } catch (err) {
          lastErr = err;
        } finally {
          client.release();
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
      throw lastErr;
    },

    async flushPendingMeters(log) {
      if (!stripeSecret || !meterEventName) return 0;
      // The repo query only returns rows that are reportable NOW: an account with
      // a Stripe customer, backoff elapsed, and under the retry ceiling. Rows
      // without a customer, still in backoff, or poison (past the ceiling) are
      // skipped so a handful of permanently-failing events can never occupy the
      // batch head and starve newer usage — the retention sweep prunes them.
      const pending = await listPendingMeterEvents(pool);
      // Independent, idempotent POSTs (keyed by requestId) — report them with
      // bounded concurrency so a large backlog drains within a tick instead of
      // serializing up to `limit` round trips at hundreds of ms each.
      const outcomes = await mapWithConcurrency(pending, 8, async (event) => {
        let result;
        try {
          result = await createStripeMeterEvent(
            stripeSecret,
            {
              eventName: meterEventName,
              stripeCustomerId: event.stripeCustomerId,
              value: event.costUsd,
              identifier: event.requestId,
              // Bill the usage in the period it occurred, not when the flush ran.
              timestamp: Math.floor(event.createdAtMs / 1000),
            },
            fetchImpl,
          );
        } catch (err) {
          // Should not happen (createStripeMeterEvent maps network errors to a
          // retryable result), but never let one row abort the batch.
          result = { ok: false as const, retryable: true, error: err instanceof Error ? err.message : String(err) };
        }
        if (result.ok) {
          await markMeterReported(pool, event.requestId, result.id);
          return true;
        }
        await recordMeterFailure(pool, event.requestId, result.error, {
          permanent: !result.retryable,
          attempts: event.attempts,
        });
        // Loudly surface rows that just became poison so their (unbilled) usage
        // is visible in logs before the retention sweep drops it.
        if (!result.retryable || event.attempts + 1 >= MAX_METER_ATTEMPTS) {
          log?.warn(
            { requestId: event.requestId, status: result.status, error: result.error, costUsd: event.costUsd },
            "stripe meter event permanently unreportable — this usage will not be invoiced",
          );
        } else {
          log?.error({ requestId: event.requestId, error: result.error }, "stripe meter report failed; will retry");
        }
        return false;
      });
      return outcomes.filter(Boolean).length;
    },

    async handleStripeWebhook(rawBody, signature, log) {
      if (!stripeWebhookSecret) {
        throw new Error("Stripe webhook secret is not configured");
      }
      if (!signature || !verifyStripeWebhookSignature(rawBody, signature, stripeWebhookSecret)) {
        throw new Error("Invalid Stripe webhook signature");
      }

      const event = JSON.parse(rawBody.toString("utf8")) as StripeEvent;
      await applyStripeEvent(pool, event, {
        planMap,
        usdPerCredit,
        downgradeUserType: billing.stripe?.downgradeUserType ?? "free_user",
        log,
      });
    },

    async adminTopUp(params) {
      const { idempotencyKey, ...rest } = params;
      await topUpCreditsInTransaction(pool, {
        ...rest,
        // Namespaced by tenant + user (not just the raw key) so the same
        // Idempotency-Key reused across DIFFERENT grants (e.g. topping up user A
        // then user B, or two tenants) does not silently collapse into one via
        // the shared stripe_processed_events dedup table — which would drop the
        // second grant with a misleading {ok:true}. Also prefixed so it can't
        // collide with a real Stripe event id.
        stripeEventId: idempotencyKey
          ? `admin-topup:${rest.tenantId ?? ""}:${rest.userId}:${idempotencyKey}`
          : undefined,
      });
    },
  };
}

async function applyStripeEvent(
  pool: Pool,
  event: StripeEvent,
  opts: {
    planMap: Record<string, string>;
    usdPerCredit: number;
    /** user_type applied on invoice.payment_failed (config: stripe.downgrade_user_type). */
    downgradeUserType: string;
    log?: { warn(obj: unknown, msg: string): void };
  },
): Promise<void> {
  const obj = event.data.object;

  switch (event.type) {
    // async_payment_succeeded fires when a deferred method (ACH/SEPA/boleto)
    // finally clears; it carries the same session shape, so both grant here.
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.completed": {
      const session = obj as StripeCheckoutSession;
      const userId = session.metadata?.user_id ?? session.metadata?.userId;
      if (!userId) return;
      // Only grant once funds have cleared. Asynchronous methods complete the
      // session with payment_status "unpaid" and settle later via
      // async_payment_succeeded — crediting on the "unpaid" completion would hand
      // out credits for money that can still bounce (with no clawback path).
      if (session.payment_status === "unpaid") {
        opts.log?.warn(
          { customerId: session.customer, userId, eventId: event.id },
          "checkout.session payment_status is 'unpaid' (async payment not yet cleared) — deferring the credit grant until checkout.session.async_payment_succeeded",
        );
        return;
      }
      const customerId = typeof session.customer === "string" ? session.customer : undefined;
      // Resolve which tenant the credits belong to. Prefer explicit metadata
      // (an empty string is a valid single-tenant value and is respected as-is).
      // If tenant_id is absent, fall back to the tenant of the customer's
      // existing billing account (a returning buyer). Only if neither resolves
      // do we credit the default "" tenant — and we warn, because in a
      // multi-tenant deployment that silently strands a paid top-up in the wrong
      // tenant (the buyer's wallet lives under their real tenant).
      let tenantId = session.metadata?.tenant_id ?? session.metadata?.tenantId;
      if (tenantId == null && customerId) {
        const existing = await findAccountByStripeCustomer(pool, customerId);
        if (existing) tenantId = existing.tenantId;
      }
      if (tenantId == null) {
        opts.log?.warn(
          { customerId, userId, eventId: event.id },
          "checkout.session.completed has no tenant_id metadata and no existing account for the customer; crediting the default tenant. Set metadata.tenant_id on the Checkout Session for multi-tenant deployments.",
        );
        tenantId = "";
      }
      // metadata.credits_usd is integrator-set free text: only honor a finite,
      // positive number (guards against NaN / Infinity, e.g. "1e309", which the
      // numeric column would reject and 500 the webhook). It is an explicit
      // wallet-USD grant and is honored verbatim (no markup/FX). Otherwise fall
      // back to the Stripe-authoritative amount_total, converted at the sell rate.
      const metaCredits = Number(session.metadata?.credits_usd);
      let creditsUsd = 0;
      if (Number.isFinite(metaCredits) && metaCredits > 0) {
        creditsUsd = metaCredits;
      } else if (session.amount_total != null) {
        const currency = session.currency?.toLowerCase();
        if (currency && currency !== "usd") {
          // The wallet is USD-denominated; granting amount_total/100 as USD for a
          // EUR/GBP/JPY checkout would credit the wrong FX (and JPY is zero-decimal,
          // so /100 is 100× off). Skip and tell the integrator to be explicit.
          opts.log?.warn(
            { customerId, userId, eventId: event.id, currency },
            "checkout.session.completed is not in USD but the credit wallet is USD-denominated; skipping the grant to avoid a wrong-currency credit — set metadata.credits_usd (in USD) for non-USD checkouts.",
          );
        } else {
          // amount_total is in the minor unit (cents for USD). usd_per_credit is
          // the operator's sell rate (see PAR_USD_PER_CREDIT); a higher rate grants
          // proportionally less wallet credit per dollar paid (markup). Guard a
          // non-positive rate (schema enforces positive, but be defensive) as par.
          const rate = opts.usdPerCredit > 0 ? PAR_USD_PER_CREDIT / opts.usdPerCredit : 1;
          creditsUsd = roundUsd((session.amount_total / 100) * rate);
        }
      }
      if (creditsUsd > 0 && Number.isFinite(creditsUsd)) {
        await topUpCreditsInTransaction(pool, {
          tenantId,
          userId,
          creditsUsd,
          stripeCustomerId: customerId,
          userType: session.metadata?.user_type,
          // Replay-safe: the same event id grants credits at most once.
          stripeEventId: event.id,
        });
      }
      break;
    }
    case "customer.subscription.deleted":
    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const sub = obj as StripeSubscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : undefined;
      if (!customerId) return;
      const account = await findAccountByStripeCustomer(pool, customerId);
      if (!account) return;
      const deleted = event.type === "customer.subscription.deleted";
      const status = sub.status?.toLowerCase();
      // Only an active/trialing subscription grants the paid user_type. A
      // deletion, or any non-active status (canceled, unpaid, past_due,
      // incomplete, incomplete_expired, paused) downgrades. This stops an
      // `incomplete` subscription (initial payment not yet cleared) from granting
      // paid access, and makes a clean cancellation actually downgrade — a
      // `...deleted` event fires with no matching payment_failed. Status absent
      // (Stripe always sends it) is treated as active to avoid spurious
      // downgrades on an unexpected payload shape.
      const ACTIVE_STATUSES = new Set(["active", "trialing"]);
      const isActive = status ? ACTIVE_STATUSES.has(status) : true;
      const isDowngrade = deleted || !isActive;
      let userType: string | undefined;
      if (isDowngrade) {
        userType = opts.downgradeUserType;
      } else {
        const priceId = sub.items?.data?.[0]?.price?.id;
        userType = priceId ? opts.planMap[priceId] : undefined;
      }
      if (userType) {
        // Ordering guard: skip an event older than the last applied subscription
        // event for this account. Without it, a redelivered/resent `active` that
        // arrives AFTER a `deleted` would re-grant the paid tier to a cancelled
        // account (Stripe retries for ~3 days). event.created is stable across
        // redeliveries; absent only on a malformed payload → treat as 0 (apply).
        const applied = await applySubscriptionUserType(pool, {
          tenantId: account.tenantId,
          userId: account.userId,
          userType,
          stripeCustomerId: customerId,
          eventCreatedAt: typeof event.created === "number" ? event.created : 0,
          isDowngrade,
        });
        if (!applied) {
          opts.log?.warn(
            { customerId, eventId: event.id, eventType: event.type, eventCreated: event.created },
            "skipped a stale customer.subscription.* event (older than the last applied one) to avoid re-applying a superseded state",
          );
        }
      }
      break;
    }
    case "invoice.payment_failed": {
      const invoice = obj as StripeInvoice;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : undefined;
      if (!customerId) return;
      const account = await findAccountByStripeCustomer(pool, customerId);
      if (!account) return;
      // A payment failure is a downgrade — route it through the SAME ordering
      // guard so a late-redelivered failure can't overwrite a newer active
      // subscription state that already restored access.
      await applySubscriptionUserType(pool, {
        tenantId: account.tenantId,
        userId: account.userId,
        userType: opts.downgradeUserType,
        stripeCustomerId: customerId,
        eventCreatedAt: typeof event.created === "number" ? event.created : 0,
        isDowngrade: true,
      });
      break;
    }
    default:
      break;
  }
}
