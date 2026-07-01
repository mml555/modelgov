import { createHash } from "node:crypto";
import { parseConfig, type AiGuardConfig } from "@ai-guard/policy-engine";
import type { Pool } from "pg";

export interface ConfigVersionRecord {
  id: string;
  createdAt: string;
  author?: string;
  note?: string;
  checksum: string;
  active: boolean;
  activatedAt?: string;
}

interface ConfigVersionDbRow {
  id: string;
  created_at: Date;
  author: string | null;
  note: string | null;
  checksum: string;
  active: boolean;
  activated_at: Date | null;
  yaml_text?: string;
}

function rowToRecord(row: ConfigVersionDbRow): ConfigVersionRecord {
  return {
    id: row.id,
    createdAt: row.created_at.toISOString(),
    author: row.author ?? undefined,
    note: row.note ?? undefined,
    checksum: row.checksum,
    active: row.active,
    activatedAt: row.activated_at?.toISOString(),
  };
}

const META_FIELDS = "id, created_at, author, note, checksum, active, activated_at";

/**
 * Validate and store a new (inactive) policy version. Throws PolicyConfigError
 * (mapped to 400 by the caller) if the YAML doesn't parse/validate — an invalid
 * version can never enter the store.
 */
export async function saveConfigVersion(
  pool: Pool,
  input: { yaml: string; author?: string; note?: string },
): Promise<ConfigVersionRecord> {
  parseConfig(input.yaml); // throws on invalid config
  const checksum = createHash("sha256").update(input.yaml).digest("hex");
  const { rows } = await pool.query<ConfigVersionDbRow>(
    `INSERT INTO config_versions (author, note, yaml_text, checksum)
     VALUES ($1, $2, $3, $4)
     RETURNING ${META_FIELDS}`,
    [input.author ?? null, input.note ?? null, input.yaml, checksum],
  );
  const row = rows[0];
  if (!row) throw new Error("config version insert returned no row");
  return rowToRecord(row);
}

export async function listConfigVersions(pool: Pool): Promise<ConfigVersionRecord[]> {
  const { rows } = await pool.query<ConfigVersionDbRow>(
    `SELECT ${META_FIELDS} FROM config_versions ORDER BY id DESC`,
  );
  return rows.map(rowToRecord);
}

export async function getActiveConfigVersion(
  pool: Pool,
): Promise<{ record: ConfigVersionRecord; config: AiGuardConfig; yaml: string } | null> {
  const { rows } = await pool.query<ConfigVersionDbRow>(
    `SELECT ${META_FIELDS}, yaml_text FROM config_versions WHERE active LIMIT 1`,
  );
  const row = rows[0];
  if (!row || !row.yaml_text) return null;
  return { record: rowToRecord(row), config: parseConfig(row.yaml_text), yaml: row.yaml_text };
}

/**
 * Activate a stored version (this is also how rollback works — activate a prior
 * id). Re-validates the target before flipping. Returns null if the id is
 * unknown. Atomic: deactivate-all then activate-one inside one transaction so
 * the single-active invariant holds.
 */
export async function activateConfigVersion(
  pool: Pool,
  id: string,
): Promise<ConfigVersionRecord | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await client.query<ConfigVersionDbRow>(
      "SELECT yaml_text FROM config_versions WHERE id = $1 FOR UPDATE",
      [id],
    );
    const yaml = target.rows[0]?.yaml_text;
    if (!yaml) {
      await client.query("ROLLBACK");
      return null;
    }
    parseConfig(yaml); // never activate an unparseable version
    await client.query("UPDATE config_versions SET active = false WHERE active");
    const { rows } = await client.query<ConfigVersionDbRow>(
      `UPDATE config_versions SET active = true, activated_at = now()
       WHERE id = $1 RETURNING ${META_FIELDS}`,
      [id],
    );
    await client.query("COMMIT");
    return rows[0] ? rowToRecord(rows[0]) : null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
