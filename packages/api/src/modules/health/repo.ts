import type { Pool } from "pg";

export async function pingDatabase(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}
