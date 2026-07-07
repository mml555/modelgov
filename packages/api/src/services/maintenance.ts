import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import { tryWithAdvisoryLock } from "../db/advisoryLock";
import { mapWithConcurrency } from "../util/concurrency";
import {
  cleanupOldRequestLogs,
  cleanupOldRequestLogsForFeature,
} from "../modules/usage/auditLogRepo";
import { cleanupCompletedIdempotencyKeys, cleanupStaleIdempotencyKeys } from "../modules/idempotency/repo";
import { cleanupStaleReservationLeases } from "../modules/usage/reservationLeases";
import { cleanupStaleNodeLeases } from "../modules/budgets/repo";
import {
  cleanupMeterEvents,
  cleanupStaleBillingLeases,
  cleanupStripeProcessedEvents,
} from "../modules/billing/repo";
import type { BillingService } from "../modules/billing/service";
import {
  claimPendingWebhooks,
  cleanupWebhookOutbox,
  deliverOutboxWebhook,
  markWebhookDelivered,
  markWebhookFailed,
} from "./webhookOutbox";

const INTERVAL_MS = 60_000;
// Distinct from the migration advisory lock key.
const MAINTENANCE_LOCK_KEY = 918_273_646;
// Separate lock for the network delivery phase (webhook POSTs, Stripe meter
// flush). Held only while delivering, so a slow/hung endpoint can't keep the
// NEXT tick from acquiring MAINTENANCE_LOCK_KEY and running the timely, money-
// critical reconciliation (idempotency + reservation-lease cleanup).
const DELIVERY_LOCK_KEY = 918_273_647;

// Retention for terminal billing/outbox rows. Not env-configurable on purpose:
// these tables are internal plumbing (idempotency records, delivered webhooks,
// reported meter rows), not user data — a debugging window is all they owe.
const DELIVERED_WEBHOOK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const DEAD_WEBHOOK_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90d (operator can inspect/replay)
const REPORTED_METER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const ABANDONED_METER_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90d, logged as a warning
// Stripe retries webhooks for days; 90d is comfortably past any replay horizon.
const STRIPE_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface MaintenanceOptions {
  pool: Pool;
  idempotencyStaleMs: number;
  idempotencyCompletedRetentionMs: number;
  reservationStaleMs: number;
  requestLogRetentionMs: number;
  /** Optional per-feature retention overrides (days), applied after the global sweep. */
  featureRetentionDays?: Record<string, number>;
  billing?: BillingService;
  /** Allow outbox delivery to private/link-local hosts (mirrors BUDGET_ALERT_WEBHOOK_ALLOW_PRIVATE). */
  allowPrivateWebhookHosts?: boolean;
  log?: FastifyBaseLogger;
}

export function startMaintenance(opts: MaintenanceOptions): NodeJS.Timeout {
  const tick = async () => {
    try {
      // Only one replica sweeps per tick. Every replica runs this timer, but a
      // non-blocking advisory lock elects a single worker so the DB doesn't do N×
      // the cleanup and N concurrent bulk DELETEs don't contend. Losers just skip.
      //
      // Reconciliation and network delivery take SEPARATE locks: the delivery
      // phase can be slow (third-party webhook / Stripe latency), and holding a
      // single lock across it would make the next tick skip reconciliation too.
      // With distinct keys, a slow delivery only delays the next delivery pass —
      // lease/idempotency reconciliation stays on schedule.
      await tryWithAdvisoryLock(opts.pool, MAINTENANCE_LOCK_KEY, () =>
        runReconciliationSweep(opts),
      );
      await tryWithAdvisoryLock(opts.pool, DELIVERY_LOCK_KEY, () =>
        runDeliverySweep(opts),
      );
    } catch (err) {
      opts.log?.error({ err }, "maintenance tick failed");
    }
  };

  void tick();
  return setInterval(() => void tick(), INTERVAL_MS);
}

/**
 * Reconciliation phase: prune stale idempotency keys, release stale reservation
 * leases (flat + hierarchical + credit wallet), and enforce request-log
 * retention (global + per-feature). Money-critical and must stay timely, so the
 * tick runs it under its own advisory lock, released before network delivery.
 */
export async function runReconciliationSweep(opts: MaintenanceOptions): Promise<void> {
  // Each step runs in isolation: the steps are independent, and the money-
  // critical lease sweeps must not be starved by an earlier step that starts
  // failing (e.g. an idempotency cleanup hitting a statement timeout on a bloated
  // table). Without this, one persistently-failing step would silently block
  // every step after it on every tick — stranding wallet reservations forever.
  const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      opts.log?.error({ err, step: name }, "maintenance reconciliation step failed");
    }
  };

  await step("idempotency-stale", async () => {
    const removedKeys = await cleanupStaleIdempotencyKeys(opts.pool, opts.idempotencyStaleMs);
    if (removedKeys > 0) opts.log?.info({ removed: removedKeys }, "cleaned stale idempotency keys");
  });

  await step("idempotency-completed", async () => {
    const removedCompleted = await cleanupCompletedIdempotencyKeys(
      opts.pool,
      opts.idempotencyCompletedRetentionMs,
    );
    if (removedCompleted > 0) {
      opts.log?.info({ removed: removedCompleted }, "pruned completed idempotency keys past retention");
    }
  });

  await step("reservation-leases", async () => {
    await cleanupStaleReservationLeases(opts.pool, opts.reservationStaleMs, Date.now(), opts.log);
  });

  // Hierarchical-budget reservation leases (same TTL as the flat path).
  await step("node-leases", async () => {
    const releasedNodeLeases = await cleanupStaleNodeLeases(opts.pool, opts.reservationStaleMs);
    if (releasedNodeLeases > 0) {
      opts.log?.info({ released: releasedNodeLeases }, "released stale budget node leases");
    }
  });

  // Prepaid-credit wallet leases (same TTL): a crash or failed settle between
  // credit reserve and settle/release would otherwise strand
  // credits_reserved_usd and shrink the user's available balance forever.
  await step("billing-leases", async () => {
    const releasedBillingLeases = await cleanupStaleBillingLeases(opts.pool, opts.reservationStaleMs);
    if (releasedBillingLeases > 0) {
      opts.log?.info({ released: releasedBillingLeases }, "released stale billing credit leases");
    }
  });

  await step("request-log-retention", async () => {
    const removedLogs = await cleanupOldRequestLogs(opts.pool, opts.requestLogRetentionMs);
    if (removedLogs > 0) opts.log?.info({ removed: removedLogs }, "pruned old request_logs rows");
  });

  // Per-feature retention overrides (stricter windows for sensitive features).
  for (const [feature, days] of Object.entries(opts.featureRetentionDays ?? {})) {
    await step(`feature-retention:${feature}`, async () => {
      const removed = await cleanupOldRequestLogsForFeature(
        opts.pool,
        feature,
        days * 24 * 60 * 60 * 1000,
      );
      if (removed > 0) opts.log?.info({ feature, removed }, "pruned request_logs for feature retention");
    });
  }
}

/**
 * Combined sweep: reconciliation followed by delivery. Kept as a single entry
 * point (tests call it directly); the periodic tick instead runs the two phases
 * under separate advisory locks so slow delivery can't starve reconciliation.
 */
export async function runMaintenanceSweep(opts: MaintenanceOptions): Promise<void> {
  await runReconciliationSweep(opts);
  await runDeliverySweep(opts);
}

/**
 * Network delivery phase: flush the webhook outbox and the Stripe meter, then
 * prune the terminal outbox / meter / stripe-event rows past retention. Held
 * under a separate lock from reconciliation so third-party latency (a slow or
 * hung endpoint) can never delay lease/idempotency cleanup on the next tick.
 */
export async function runDeliverySweep(opts: MaintenanceOptions): Promise<void> {
  // Webhook outbox delivery runs unconditionally: budget alerts (a non-billing
  // feature) also enqueue here, so gating on billing would strand their webhooks.
  const pending = await claimPendingWebhooks(opts.pool);
  // Deliver to independent destinations with bounded concurrency so one slow or
  // hung endpoint (each POST has a 10s timeout) only delays itself, not the rest
  // of the batch.
  await mapWithConcurrency(pending, 8, async (entry) => {
    try {
      await deliverOutboxWebhook(entry, fetch, {
        allowPrivateHosts: opts.allowPrivateWebhookHosts,
      });
      await markWebhookDelivered(opts.pool, entry.id);
    } catch (err) {
      await markWebhookFailed(
        opts.pool,
        entry.id,
        err instanceof Error ? err.message : String(err),
        entry.attempts,
      );
    }
  });

  // Stripe meter flush is billing-specific.
  if (opts.billing?.enabled) {
    const reported = await opts.billing.flushPendingMeters(opts.log);
    if (reported > 0) {
      opts.log?.info({ reported }, "flushed pending stripe meter events");
    }
  }

  // Retention for terminal rows — without these the outbox, meter, and Stripe
  // idempotency tables grow without bound.
  const outboxRemoved = await cleanupWebhookOutbox(opts.pool, {
    deliveredRetentionMs: DELIVERED_WEBHOOK_RETENTION_MS,
    deadRetentionMs: DEAD_WEBHOOK_RETENTION_MS,
  });
  if (outboxRemoved > 0) {
    opts.log?.info({ removed: outboxRemoved }, "pruned webhook outbox rows past retention");
  }

  const meters = await cleanupMeterEvents(opts.pool, {
    reportedRetentionMs: REPORTED_METER_RETENTION_MS,
    abandonedRetentionMs: ABANDONED_METER_RETENTION_MS,
  });
  if (meters.reported > 0) {
    opts.log?.info({ removed: meters.reported }, "pruned reported meter events past retention");
  }
  if (meters.abandoned > 0) {
    // Abandoned = unreported and past the window: usage that was NEVER billed
    // to the Stripe meter (typically an account with no Stripe customer id).
    opts.log?.warn(
      { removed: meters.abandoned },
      "dropped meter events that could never be reported (no Stripe customer?) — this usage was not invoiced",
    );
  }

  const stripeEvents = await cleanupStripeProcessedEvents(
    opts.pool,
    STRIPE_EVENT_RETENTION_MS,
  );
  if (stripeEvents > 0) {
    opts.log?.info({ removed: stripeEvents }, "pruned stripe processed-event records past retention");
  }
}
