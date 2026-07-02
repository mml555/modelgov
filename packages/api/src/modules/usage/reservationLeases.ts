import type { Pool } from "pg";
import { releaseBudget } from "./repo";
import { findStaleReservationLeases } from "./reservationLeaseRepo";

export async function cleanupStaleReservationLeases(
  pool: Pool,
  staleMs: number,
  now = Date.now(),
  log?: { info(obj: unknown, msg: string): void },
): Promise<number> {
  const cutoff = new Date(now - staleMs).toISOString();
  const rows = await findStaleReservationLeases(pool, cutoff);

  let released = 0;
  for (const row of rows) {
    await releaseBudget(pool, {
      projectId: row.project_id,
      userId: row.user_id,
      feature: row.feature,
      estimatedCostUsd: Number(row.estimated_cost),
      estimatedTokens: Number(row.estimated_tokens),
      caps: row.caps,
      now: new Date(`${row.window_day}T12:00:00.000Z`),
      windows: { day: row.window_day, month: row.window_month },
      leaseId: row.id,
      tenantId: row.tenant_id,
    });
    released += 1;
  }

  if (released > 0) {
    log?.info({ released, staleMs }, "released stale budget reservation leases");
  }
  return released;
}
