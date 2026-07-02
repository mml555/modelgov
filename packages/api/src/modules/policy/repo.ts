import { createHash } from "node:crypto";
import { parseConfig, type AiGuardConfig } from "@ai-guard/policy-engine";
import type { Pool } from "pg";
import { withTenantContext, withTransaction } from "../../db/pool";
import { appendAuditInTransaction, type AuditEvent } from "../audit/repo";

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

/** Anything that can run a query — a Pool, or a PoolClient inside a transaction. */
type Queryable = Pick<Pool, "query">;

// Process-wide toggle for optional config_versions row-level security. Set once
// at boot from DB_RLS_ENABLED. When on, every config_versions statement runs
// inside a transaction that sets `app.current_tenant` so the RLS policy applies
// (see db/rls.ts). Off = plain pool queries, unchanged.
let rlsEnabled = false;
export function setConfigVersionsRls(enabled: boolean): void {
  rlsEnabled = enabled;
}

/**
 * Run a config_versions statement, transparently wrapping it in the RLS tenant
 * context when enabled. Centralizing it here keeps the repo the single place
 * that knows about RLS — routes and the resolver call these functions unchanged.
 */
async function scoped<T>(
  pool: Pool,
  tenantId: string,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  return rlsEnabled ? withTenantContext(pool, tenantId, fn) : fn(pool);
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
const DEFAULT_TENANT = "default";

export async function saveConfigVersion(
  pool: Pool,
  input: { yaml: string; author?: string; note?: string; tenantId?: string },
  audit?: (record: ConfigVersionRecord) => AuditEvent,
): Promise<ConfigVersionRecord> {
  parseConfig(input.yaml); // throws on invalid config
  const checksum = createHash("sha256").update(input.yaml).digest("hex");
  const tenantId = input.tenantId ?? DEFAULT_TENANT;
  const insert = async (db: Queryable): Promise<ConfigVersionRecord> => {
    const { rows } = await db.query<ConfigVersionDbRow>(
      `INSERT INTO config_versions (tenant_id, author, note, yaml_text, checksum)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${META_FIELDS}`,
      [tenantId, input.author ?? null, input.note ?? null, input.yaml, checksum],
    );
    const row = rows[0];
    if (!row) throw new Error("config version insert returned no row");
    const record = rowToRecord(row);
    if (audit) await appendAuditInTransaction(db, audit(record));
    return record;
  };
  if (audit) {
    return rlsEnabled
      ? withTenantContext(pool, tenantId, insert)
      : withTransaction(pool, insert);
  }
  return scoped(pool, tenantId, insert);
}

export async function listConfigVersions(
  pool: Pool,
  tenantId: string = DEFAULT_TENANT,
): Promise<ConfigVersionRecord[]> {
  const { rows } = await scoped(pool, tenantId, (db) =>
    db.query<ConfigVersionDbRow>(
      `SELECT ${META_FIELDS} FROM config_versions WHERE tenant_id = $1 ORDER BY id DESC`,
      [tenantId],
    ),
  );
  return rows.map(rowToRecord);
}

/** Fetch a stored version's YAML by id (tenant-scoped). */
export async function getConfigVersionYaml(
  pool: Pool,
  id: string,
  tenantId: string = DEFAULT_TENANT,
): Promise<string | null> {
  const { rows } = await scoped(pool, tenantId, (db) =>
    db.query<{ yaml_text: string }>(
      "SELECT yaml_text FROM config_versions WHERE id = $1 AND tenant_id = $2",
      [id, tenantId],
    ),
  );
  return rows[0]?.yaml_text ?? null;
}

export async function getActiveConfigVersion(
  pool: Pool,
  tenantId: string = DEFAULT_TENANT,
): Promise<{ record: ConfigVersionRecord; config: AiGuardConfig; yaml: string } | null> {
  const { rows } = await scoped(pool, tenantId, (db) =>
    db.query<ConfigVersionDbRow>(
      `SELECT ${META_FIELDS}, yaml_text FROM config_versions WHERE active AND tenant_id = $1 LIMIT 1`,
      [tenantId],
    ),
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
  expectedTenantId?: string,
  audit?: (record: ConfigVersionRecord) => AuditEvent,
): Promise<ConfigVersionRecord | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Under RLS the deactivate/activate and the FOR UPDATE lookup below must run
    // with the tenant context set, or a non-owner role sees no rows.
    if (rlsEnabled) {
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [
        expectedTenantId ?? DEFAULT_TENANT,
      ]);
    }
    const target = await client.query<{ yaml_text: string; tenant_id: string }>(
      "SELECT yaml_text, tenant_id FROM config_versions WHERE id = $1 FOR UPDATE",
      [id],
    );
    const yaml = target.rows[0]?.yaml_text;
    const tenantId = target.rows[0]?.tenant_id;
    // Tenant isolation: a caller may only activate versions in its own tenant.
    if (!yaml || !tenantId || (expectedTenantId != null && tenantId !== expectedTenantId)) {
      await client.query("ROLLBACK");
      return null;
    }
    parseConfig(yaml); // never activate an unparseable version
    // Deactivate only this tenant's currently-active version.
    await client.query("UPDATE config_versions SET active = false WHERE active AND tenant_id = $1", [tenantId]);
    const { rows } = await client.query<ConfigVersionDbRow>(
      `UPDATE config_versions SET active = true, activated_at = now()
       WHERE id = $1 RETURNING ${META_FIELDS}`,
      [id],
    );
    const record = rows[0] ? rowToRecord(rows[0]) : null;
    if (record && audit) await appendAuditInTransaction(client, audit(record));
    await client.query("COMMIT");
    return record;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
