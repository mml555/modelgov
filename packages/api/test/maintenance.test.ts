import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  runMaintenanceSweep,
  startMaintenance,
  type MaintenanceOptions,
} from "../src/services/maintenance";

vi.mock("../src/modules/idempotency/repo", () => ({
  cleanupStaleIdempotencyKeys: vi.fn(),
  cleanupCompletedIdempotencyKeys: vi.fn(),
}));

vi.mock("../src/modules/usage/reservationLeases", () => ({
  cleanupStaleReservationLeases: vi.fn(),
}));

vi.mock("../src/modules/budgets/repo", () => ({
  cleanupStaleNodeLeases: vi.fn(),
}));

vi.mock("../src/modules/usage/auditLogRepo", () => ({
  cleanupOldRequestLogs: vi.fn(),
  cleanupOldRequestLogsForFeature: vi.fn(),
}));

vi.mock("../src/db/advisoryLock", () => ({
  tryWithAdvisoryLock: vi.fn(async (_pool, _key, fn) => {
    await fn();
    return true;
  }),
}));

vi.mock("../src/services/webhookOutbox", () => ({
  claimPendingWebhooks: vi.fn(async () => []),
  markWebhookDelivered: vi.fn(),
  markWebhookFailed: vi.fn(),
}));

import {
  cleanupCompletedIdempotencyKeys,
  cleanupStaleIdempotencyKeys,
} from "../src/modules/idempotency/repo";
import { cleanupStaleNodeLeases } from "../src/modules/budgets/repo";
import {
  cleanupOldRequestLogs,
  cleanupOldRequestLogsForFeature,
} from "../src/modules/usage/auditLogRepo";
import { cleanupStaleReservationLeases } from "../src/modules/usage/reservationLeases";
import { tryWithAdvisoryLock } from "../src/db/advisoryLock";

function baseOpts(over: Partial<MaintenanceOptions> = {}): MaintenanceOptions {
  return {
    pool: {} as Pool,
    idempotencyStaleMs: 900_000,
    idempotencyCompletedRetentionMs: 604_800_000,
    reservationStaleMs: 900_000,
    requestLogRetentionMs: 2_592_000_000,
    ...over,
  };
}

describe("runMaintenanceSweep", () => {
  beforeEach(() => {
    vi.mocked(cleanupStaleIdempotencyKeys).mockResolvedValue(0);
    vi.mocked(cleanupCompletedIdempotencyKeys).mockResolvedValue(0);
    vi.mocked(cleanupStaleReservationLeases).mockResolvedValue(0);
    vi.mocked(cleanupStaleNodeLeases).mockResolvedValue(0);
    vi.mocked(cleanupOldRequestLogs).mockResolvedValue(0);
    vi.mocked(cleanupOldRequestLogsForFeature).mockResolvedValue(0);
  });

  it("runs all cleanup steps in order", async () => {
    const calls: string[] = [];
    vi.mocked(cleanupStaleIdempotencyKeys).mockImplementation(async () => {
      calls.push("stale-idempotency");
      return 2;
    });
    vi.mocked(cleanupCompletedIdempotencyKeys).mockImplementation(async () => {
      calls.push("completed-idempotency");
      return 1;
    });
    vi.mocked(cleanupStaleReservationLeases).mockImplementation(async () => {
      calls.push("reservation-leases");
      return 0;
    });
    vi.mocked(cleanupStaleNodeLeases).mockImplementation(async () => {
      calls.push("node-leases");
      return 3;
    });
    vi.mocked(cleanupOldRequestLogs).mockImplementation(async () => {
      calls.push("request-logs");
      return 5;
    });

    const info = vi.fn();
    await runMaintenanceSweep(baseOpts({ log: { info } as never }));

    expect(calls).toEqual([
      "stale-idempotency",
      "completed-idempotency",
      "reservation-leases",
      "node-leases",
      "request-logs",
    ]);
    expect(info).toHaveBeenCalledWith({ removed: 2 }, "cleaned stale idempotency keys");
    expect(info).toHaveBeenCalledWith({ removed: 1 }, "pruned completed idempotency keys past retention");
    expect(info).toHaveBeenCalledWith({ released: 3 }, "released stale budget node leases");
    expect(info).toHaveBeenCalledWith({ removed: 5 }, "pruned old request_logs rows");
  });

  it("applies per-feature retention overrides", async () => {
    vi.mocked(cleanupOldRequestLogsForFeature).mockResolvedValue(4);
    const info = vi.fn();
    await runMaintenanceSweep(
      baseOpts({
        featureRetentionDays: { support_chat: 7 },
        log: { info } as never,
      }),
    );
    expect(cleanupOldRequestLogsForFeature).toHaveBeenCalledWith(
      expect.anything(),
      "support_chat",
      7 * 24 * 60 * 60 * 1000,
    );
    expect(info).toHaveBeenCalledWith(
      { feature: "support_chat", removed: 4 },
      "pruned request_logs for feature retention",
    );
  });

  it("skips log lines when nothing was removed", async () => {
    const info = vi.fn();
    await runMaintenanceSweep(baseOpts({ log: { info } as never }));
    expect(info).not.toHaveBeenCalled();
  });
});

describe("startMaintenance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(cleanupStaleIdempotencyKeys).mockResolvedValue(0);
    vi.mocked(cleanupCompletedIdempotencyKeys).mockResolvedValue(0);
    vi.mocked(cleanupStaleReservationLeases).mockResolvedValue(0);
    vi.mocked(cleanupStaleNodeLeases).mockResolvedValue(0);
    vi.mocked(cleanupOldRequestLogs).mockResolvedValue(0);
    vi.mocked(tryWithAdvisoryLock).mockImplementation(async (_p, _k, fn) => {
      await fn();
      return true;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs an immediate tick and schedules periodic sweeps under the advisory lock", async () => {
    const timer = startMaintenance(baseOpts());
    await vi.runOnlyPendingTimersAsync();
    expect(tryWithAdvisoryLock).toHaveBeenCalled();
    expect(cleanupStaleIdempotencyKeys).toHaveBeenCalled();
    clearInterval(timer);
  });

  it("logs maintenance tick failures without throwing", async () => {
    vi.mocked(tryWithAdvisoryLock).mockRejectedValue(new Error("lock failed"));
    const error = vi.fn();
    const timer = startMaintenance(baseOpts({ log: { error } as never }));
    await vi.runOnlyPendingTimersAsync();
    expect(error).toHaveBeenCalledWith({ err: expect.any(Error) }, "maintenance tick failed");
    clearInterval(timer);
  });
});
