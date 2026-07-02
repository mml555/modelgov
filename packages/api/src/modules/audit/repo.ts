import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { stableStringify } from "../../util/stableStringify";

// Fixed advisory-lock key so concurrent appends serialize and the hash chain
// stays linear (audit writes are low-volume, so contention is negligible).
const AUDIT_LOCK_KEY = 918_273_646;
const GENESIS_HASH = "genesis";

export interface AuditEvent {
  actor: string;
  /** Dotted verb, e.g. "key.create", "key.revoke", "policy.update". */
  action: string;
  target?: string;
  /** Non-secret context (before/after values, ids). Never store raw secrets. */
  metadata?: Record<string, unknown>;
  /** Tenant this mutation belongs to ('' = root/untenanted). Scopes reads. */
  tenantId?: string;
}

export interface AuditRecord extends AuditEvent {
  id: string;
  createdAt: string;
  prevHash: string;
  rowHash: string;
}

type TransactionClient = Pick<PoolClient, "query">;

function computeRowHash(
  prevHash: string,
  createdAtIso: string,
  event: AuditEvent,
): string {
  const canonical = [
    prevHash,
    createdAtIso,
    event.actor,
    event.action,
    event.target ?? "",
    stableStringify(event.metadata ?? {}),
    // tenant_id is part of the signed content so a row can't be silently moved
    // between tenants' views without breaking the chain.
    event.tenantId ?? "",
  ].join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function normalizeEvent(event: AuditEvent): AuditEvent {
  return {
    actor: event.actor,
    action: event.action,
    target: event.target,
    metadata: JSON.parse(JSON.stringify(event.metadata ?? {})) as Record<string, unknown>,
    tenantId: event.tenantId ?? "",
  };
}

/**
 * Append inside the caller's open transaction. Used by privileged mutations so
 * the mutation and its admin audit row commit or roll back together.
 */
export async function appendAuditInTransaction(
  client: TransactionClient,
  event: AuditEvent,
  now: Date = new Date(),
): Promise<AuditRecord> {
  const normalized = normalizeEvent(event);
  await client.query("SELECT pg_advisory_xact_lock($1)", [AUDIT_LOCK_KEY]);
  const prev = await client.query<{ row_hash: string }>(
    "SELECT row_hash FROM admin_audit_log ORDER BY id DESC LIMIT 1",
  );
  const prevHash = prev.rows[0]?.row_hash ?? GENESIS_HASH;
  const createdAtIso = now.toISOString();
  const rowHash = computeRowHash(prevHash, createdAtIso, normalized);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO admin_audit_log
       (created_at, actor, action, target, metadata, prev_hash, row_hash, tenant_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     RETURNING id`,
    [
      createdAtIso,
      normalized.actor,
      normalized.action,
      normalized.target ?? null,
      JSON.stringify(normalized.metadata ?? {}),
      prevHash,
      rowHash,
      normalized.tenantId ?? "",
    ],
  );
  const insertedId = inserted.rows[0]?.id;
  if (!insertedId) throw new Error("audit insert returned no row");
  return {
    id: insertedId,
    createdAt: createdAtIso,
    actor: normalized.actor,
    action: normalized.action,
    target: normalized.target,
    metadata: normalized.metadata,
    tenantId: normalized.tenantId,
    prevHash,
    rowHash,
  };
}

/**
 * Append an event to the hash chain. Serialized via an advisory lock inside a
 * transaction so the previous-hash read and this insert are atomic under
 * concurrency. `now` is injectable for deterministic tests.
 */
export async function appendAudit(
  pool: Pool,
  event: AuditEvent,
  now: Date = new Date(),
): Promise<AuditRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const record = await appendAuditInTransaction(client, event, now);
    await client.query("COMMIT");
    return record;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

interface AuditDbRow {
  id: string;
  created_at: Date;
  actor: string;
  action: string;
  target: string | null;
  metadata: Record<string, unknown>;
  prev_hash: string;
  row_hash: string;
  tenant_id: string;
}

export async function listAudit(
  pool: Pool,
  opts: { limit?: number; action?: string; actor?: string; tenantId?: string } = {},
): Promise<AuditRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (opts.action) {
    values.push(opts.action);
    conditions.push(`action = $${values.length}`);
  }
  if (opts.actor) {
    values.push(opts.actor);
    conditions.push(`actor = $${values.length}`);
  }
  // A tenant-scoped admin sees only its own tenant's trail; a root admin
  // (undefined) sees all.
  if (opts.tenantId !== undefined) {
    values.push(opts.tenantId);
    conditions.push(`tenant_id = $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  const { rows } = await pool.query<AuditDbRow>(
    `SELECT id, created_at, actor, action, target, metadata, prev_hash, row_hash, tenant_id
     FROM admin_audit_log ${where} ORDER BY id DESC LIMIT $${values.length}`,
    values,
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at.toISOString(),
    actor: r.actor,
    action: r.action,
    target: r.target ?? undefined,
    metadata: r.metadata,
    tenantId: r.tenant_id,
    prevHash: r.prev_hash,
    rowHash: r.row_hash,
  }));
}

export interface ChainVerification {
  ok: boolean;
  rows: number;
  /** id of the first row whose hash doesn't match (tamper point), if any. */
  brokenAtId?: string;
}

/**
 * Re-walk the whole chain from genesis, recomputing each row_hash. Returns
 * ok:false and the id where the chain first diverges if any row was altered,
 * inserted, or deleted.
 */
export async function verifyAuditChain(pool: Pool): Promise<ChainVerification> {
  const { rows } = await pool.query<AuditDbRow>(
    `SELECT id, created_at, actor, action, target, metadata, prev_hash, row_hash, tenant_id
     FROM admin_audit_log ORDER BY id ASC`,
  );
  let prevHash = GENESIS_HASH;
  for (const r of rows) {
    if (r.prev_hash !== prevHash) return { ok: false, rows: rows.length, brokenAtId: r.id };
    const expected = computeRowHash(prevHash, r.created_at.toISOString(), {
      actor: r.actor,
      action: r.action,
      target: r.target ?? undefined,
      metadata: r.metadata,
      tenantId: r.tenant_id,
    });
    if (expected !== r.row_hash) return { ok: false, rows: rows.length, brokenAtId: r.id };
    prevHash = r.row_hash;
  }
  return { ok: true, rows: rows.length };
}
