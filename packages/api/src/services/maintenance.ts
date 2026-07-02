import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import { tryWithAdvisoryLock } from "../db/advisoryLock";
import {
  cleanupOldRequestLogs,
  cleanupOldRequestLogsForFeature,
} from "../modules/usage/auditLogRepo";
import { cleanupCompletedIdempotencyKeys, cleanupStaleIdempotencyKeys } from "../modules/idempotency/repo";
import { cleanupStaleReservationLeases } from "../modules/usage/reservationLeases";
import { cleanupStaleNodeLeases } from "../modules/budgets/repo";

const INTERVAL_MS = 60_000;
// Distinct from the migration advisory lock key.
const MAINTENANCE_LOCK_KEY = 918_273_646;

export interface MaintenanceOptions {
  pool: Pool;
  idempotencyStaleMs: number;
  idempotencyCompletedRetentionMs: number;
  reservationStaleMs: number;
  requestLogRetentionMs: number;
  /** Optional per-feature retention overrides (days), applied after the global sweep. */
  featureRetentionDays?: Record<string, number>;
  log?: FastifyBaseLogger;
}

export function startMaintenance(opts: MaintenanceOptions): NodeJS.Timeout {
  const tick = async () => {
    try {
      // Only one replica sweeps per tick. Every replica runs this timer, but a
      // non-blocking advisory lock elects a single worker so the DB doesn't do N×
      // the cleanup and N concurrent bulk DELETEs don't contend. Losers just skip.
      await tryWithAdvisoryLock(opts.pool, MAINTENANCE_LOCK_KEY, () =>
        runMaintenanceSweep(opts),
      );
    } catch (err) {
      opts.log?.error({ err }, "maintenance tick failed");
    }
  };

  void tick();
  return setInterval(() => void tick(), INTERVAL_MS);
}

/**
 * One maintenance pass: prune stale idempotency keys, release stale reservation
 * leases (flat + hierarchical), and enforce request-log retention (global +
 * per-feature). Runs under the caller's advisory lock so only one replica sweeps.
 */
export async function runMaintenanceSweep(opts: MaintenanceOptions): Promise<void> {
  const removedKeys = await cleanupStaleIdempotencyKeys(
    opts.pool,
    opts.idempotencyStaleMs,
  );
  if (removedKeys > 0) {
    opts.log?.info({ removed: removedKeys }, "cleaned stale idempotency keys");
  }

  const removedCompleted = await cleanupCompletedIdempotencyKeys(
    opts.pool,
    opts.idempotencyCompletedRetentionMs,
  );
  if (removedCompleted > 0) {
    opts.log?.info(
      { removed: removedCompleted },
      "pruned completed idempotency keys past retention",
    );
  }

  await cleanupStaleReservationLeases(
    opts.pool,
    opts.reservationStaleMs,
    Date.now(),
    opts.log,
  );

  // Hierarchical-budget reservation leases (same TTL as the flat path).
  const releasedNodeLeases = await cleanupStaleNodeLeases(
    opts.pool,
    opts.reservationStaleMs,
  );
  if (releasedNodeLeases > 0) {
    opts.log?.info({ released: releasedNodeLeases }, "released stale budget node leases");
  }

  const removedLogs = await cleanupOldRequestLogs(
    opts.pool,
    opts.requestLogRetentionMs,
  );
  if (removedLogs > 0) {
    opts.log?.info({ removed: removedLogs }, "pruned old request_logs rows");
  }

  // Per-feature retention overrides (stricter windows for sensitive features).
  for (const [feature, days] of Object.entries(opts.featureRetentionDays ?? {})) {
    const removed = await cleanupOldRequestLogsForFeature(
      opts.pool,
      feature,
      days * 24 * 60 * 60 * 1000,
    );
    if (removed > 0) {
      opts.log?.info({ feature, removed }, "pruned request_logs for feature retention");
    }
  }
}
