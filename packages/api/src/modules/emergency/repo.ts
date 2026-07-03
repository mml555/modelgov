import type { Pool } from "pg";

const PAUSE_KEY = "ai_requests_paused";

export interface EmergencyPauseState {
  paused: boolean;
  reason?: string;
  pausedAt?: string;
  pausedBy?: string;
}

export async function getEmergencyPause(pool: Pool): Promise<EmergencyPauseState> {
  const { rows } = await pool.query(
    `SELECT value FROM system_flags WHERE key = $1`,
    [PAUSE_KEY],
  );
  const value = rows[0]?.value as EmergencyPauseState | undefined;
  return value ?? { paused: false };
}

export async function setEmergencyPause(
  pool: Pool,
  params: { paused: boolean; reason?: string; pausedBy?: string },
): Promise<EmergencyPauseState> {
  const value: EmergencyPauseState = params.paused
    ? {
        paused: true,
        reason: params.reason,
        pausedAt: new Date().toISOString(),
        pausedBy: params.pausedBy,
      }
    : { paused: false };

  await pool.query(
    `INSERT INTO system_flags (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [PAUSE_KEY, JSON.stringify(value)],
  );
  return value;
}
