import type { BillingConfig, BillingMode } from "@modelgov/policy-engine";
import type { Pool } from "pg";
import {
  findAccountByStripeCustomer,
  getBillingAccount,
  listPendingMeterEvents,
  markMeterReported,
  recordMeterEvent,
  releaseCredits,
  reserveCredits,
  settleCredits,
  topUpCreditsInTransaction,
  upsertBillingAccount,
} from "./repo";
import { createStripeMeterEvent, verifyStripeWebhookSignature, type StripeEvent } from "./stripe";
import type { BillingBalance, BillingServiceConfig } from "./types";

export interface BillingService {
  readonly enabled: boolean;
  readonly mode: BillingMode;
  usesCredits(): boolean;
  getBalance(tenantId: string, userId: string): Promise<BillingBalance>;
  checkCredits(
    tenantId: string,
    userId: string,
    estimatedUsd: number,
  ): Promise<{ ok: true; availableUsd: number } | { ok: false; availableUsd: number }>;
  reserveCredits(tenantId: string, userId: string, amountUsd: number): Promise<boolean>;
  releaseCredits(tenantId: string, userId: string, amountUsd: number): Promise<void>;
  settleCredits(
    tenantId: string,
    userId: string,
    reservedUsd: number,
    actualUsd: number,
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
  flushPendingMeters(log?: { error(obj: unknown, msg: string): void }): Promise<number>;
  handleStripeWebhook(rawBody: Buffer, signature: string | undefined): Promise<void>;
  adminTopUp(params: {
    tenantId: string;
    userId: string;
    creditsUsd: number;
    stripeCustomerId?: string;
    userType?: string;
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

  // Defense in depth (config validation already enforces this): reaching here
  // means mode is hybrid|credits_only, i.e. usage is billed via prepaid credits.
  // A Stripe usage meter would invoice that same usage a second time, so refuse
  // to construct a service that would double-bill.
  if (meterEventName) {
    throw new Error(
      `billing.mode "${billing.mode}" bills usage by debiting the prepaid credit wallet ` +
        "and cannot be combined with a Stripe usage meter (stripe.meterEventName) — the " +
        "same usage would be invoiced a second time. Remove stripe.meterEventName.",
    );
  }

  return {
    enabled: true,
    mode: billing.mode,
    usesCredits() {
      return billing.mode === "hybrid" || billing.mode === "credits_only";
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

    reserveCredits(tenantId, userId, amountUsd) {
      if (amountUsd <= 0) return Promise.resolve(true);
      return reserveCredits(pool, { tenantId, userId, amountUsd });
    },

    releaseCredits(tenantId, userId, amountUsd) {
      if (amountUsd <= 0) return Promise.resolve();
      return releaseCredits(pool, { tenantId, userId, amountUsd });
    },

    settleCredits(tenantId, userId, reservedUsd, actualUsd) {
      return settleCredits(pool, { tenantId, userId, reservedUsd, actualUsd });
    },

    async recordMeter(params) {
      if (params.costUsd <= 0) return;
      const client = await pool.connect();
      try {
        await recordMeterEvent(client, params);
      } finally {
        client.release();
      }
    },

    async flushPendingMeters(log) {
      if (!stripeSecret || !meterEventName) return 0;
      const pending = await listPendingMeterEvents(pool);
      let reported = 0;
      for (const event of pending) {
        const account = await getBillingAccount(pool, event.tenantId, event.userId);
        if (!account?.stripeCustomerId) continue;
        try {
          const id = await createStripeMeterEvent(stripeSecret, {
            eventName: meterEventName,
            stripeCustomerId: account.stripeCustomerId,
            value: event.costUsd,
            identifier: event.requestId,
          });
          if (id) {
            await markMeterReported(pool, event.requestId, id);
            reported += 1;
          }
        } catch (err) {
          log?.error({ err, requestId: event.requestId }, "stripe meter report failed");
        }
      }
      return reported;
    },

    async handleStripeWebhook(rawBody, signature) {
      if (!stripeWebhookSecret) {
        throw new Error("Stripe webhook secret is not configured");
      }
      if (!signature || !verifyStripeWebhookSignature(rawBody, signature, stripeWebhookSecret)) {
        throw new Error("Invalid Stripe webhook signature");
      }

      const event = JSON.parse(rawBody.toString("utf8")) as StripeEvent;
      await applyStripeEvent(pool, event, { planMap, usdPerCredit });
    },

    async adminTopUp(params) {
      await topUpCreditsInTransaction(pool, params);
    },
  };
}

async function applyStripeEvent(
  pool: Pool,
  event: StripeEvent,
  opts: { planMap: Record<string, string>; usdPerCredit: number },
): Promise<void> {
  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      const session = obj as {
        customer?: string;
        metadata?: Record<string, string>;
        amount_total?: number;
      };
      const userId = session.metadata?.user_id ?? session.metadata?.userId;
      const tenantId = session.metadata?.tenant_id ?? session.metadata?.tenantId ?? "";
      if (!userId) return;
      const creditsUsd =
        Number(session.metadata?.credits_usd ?? 0) > 0
          ? Number(session.metadata?.credits_usd)
          : session.amount_total != null
            ? session.amount_total / 100
            : 0;
      if (creditsUsd > 0) {
        await topUpCreditsInTransaction(pool, {
          tenantId,
          userId,
          creditsUsd,
          stripeCustomerId: typeof session.customer === "string" ? session.customer : undefined,
          userType: session.metadata?.user_type,
          // Replay-safe: the same event id grants credits at most once.
          stripeEventId: event.id,
        });
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const sub = obj as {
        customer?: string;
        status?: string;
        items?: { data?: Array<{ price?: { id?: string } }> };
      };
      const customerId = typeof sub.customer === "string" ? sub.customer : undefined;
      if (!customerId) return;
      const account = await findAccountByStripeCustomer(pool, customerId);
      if (!account) return;
      const priceId = sub.items?.data?.[0]?.price?.id;
      const userType = priceId ? opts.planMap[priceId] : undefined;
      if (userType) {
        await upsertBillingAccount(pool, {
          tenantId: account.tenantId,
          userId: account.userId,
          userType,
          stripeCustomerId: customerId,
        });
      }
      break;
    }
    case "invoice.payment_failed": {
      const invoice = obj as { customer?: string };
      const customerId = typeof invoice.customer === "string" ? invoice.customer : undefined;
      if (!customerId) return;
      const account = await findAccountByStripeCustomer(pool, customerId);
      if (!account) return;
      await upsertBillingAccount(pool, {
        tenantId: account.tenantId,
        userId: account.userId,
        userType: "free_user",
        stripeCustomerId: customerId,
      });
      break;
    }
    default:
      break;
  }
}

export function resolveBillingFromConfig(config: {
  billing?: BillingConfig;
}): BillingConfig | undefined {
  return config.billing;
}
