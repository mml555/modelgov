import type { ReservationCaps } from "@ai-guard/policy-engine";
import type { Pool } from "pg";

export interface StaleReservationLeaseRow {
  id: string;
  project_id: string;
  user_id: string;
  feature: string;
  estimated_cost: string;
  estimated_tokens: string;
  caps: ReservationCaps;
  window_day: string;
  window_month: string;
  tenant_id: string;
}

// window_day / window_month are `date` columns, which node-pg parses into JS
// Date objects by default (local-midnight, timezone-sensitive). Cast them to
// text so they come back as the same 'YYYY-MM-DD' strings reserveBudget wrote.
const STALE_SELECT_SQL = `
  SELECT id::text, project_id, user_id, feature, estimated_cost, estimated_tokens, caps,
         window_day::text AS window_day, window_month::text AS window_month, tenant_id
  FROM budget_reservation_leases
  WHERE leased_at < $1::timestamptz
  ORDER BY id
  FOR UPDATE SKIP LOCKED
`;

export async function findStaleReservationLeases(
  pool: Pool,
  cutoffIso: string,
): Promise<StaleReservationLeaseRow[]> {
  const { rows } = await pool.query<StaleReservationLeaseRow>(STALE_SELECT_SQL, [
    cutoffIso,
  ]);
  return rows;
}
