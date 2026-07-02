import type { Pool } from "pg";

const CLAIM_SQL = `
  INSERT INTO budget_alert_sent (scope, window_start, alert_kind)
  VALUES ('global_monthly', $1::date, 'threshold')
  ON CONFLICT DO NOTHING
  RETURNING scope
`;

export async function claimGlobalMonthlyBudgetAlert(
  pool: Pool,
  windowStart: string,
): Promise<boolean> {
  const claimed = await pool.query(CLAIM_SQL, [windowStart]);
  return claimed.rowCount === 1;
}
