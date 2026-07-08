import { createHash } from "node:crypto";
import { parseConfig, type ModelgovConfig } from "@modelgov/policy-engine";
import type { Pool } from "pg";
import { withTenantContext, withTransaction } from "../../db/pool";
import { appendAuditInTransaction, type AuditEvent } from "../audit/repo";
import { POLICY_ACTIVATED_CHANNEL } from "./listener";

/** Approval state machine: proposed -> approved | rejected. Only `approved`
 *  versions may be activated. With approval off, saves are born `approved`. */
export type PolicyVersionStatus = "proposed" | "approved" | "rejected";

export interface ConfigVersionRecord {
  id: string;
  createdAt: string;
  author?: string;
  note?: string;
  checksum: string;
  active: boolean;
  activatedAt?: string;
  status: PolicyVersionStatus;
  proposedBy?: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

interface ConfigVersionDbRow {
  id: string;
  created_at: Date;
  author: string | null;
  note: string | null;
  checksum: string;
  active: boolean;
  activated_at: Date | null;
  status: PolicyVersionStatus;
  proposed_by: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
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

// Process-wide STRICT_PRICING, set once at boot. The file loader passes this to
// parseConfig; the store path must too, or a version adding an unpriced model
// slips past the very guard STRICT_PRICING exists to enforce and its spend is
// estimated at DEFAULT_PRICE.
let strictPricing = false;
export function setConfigVersionsStrictPricing(enabled: boolean): void {
  strictPricing = enabled;
}
function parseOptions(): { strictPricing?: boolean } {
  return { strictPricing };
}

/**
 * Fingerprint of the config fields that are applied at BOOT and are NOT hot-
 * reloadable: provider pricing and routing.retry (baked into the LiteLLM client),
 * the injection classifier model (baked into the safety guard), and the billing
 * mode / meter (baked into the billing service). Hot-activating a version that
 * changes any of these would half-apply — the evaluator would use the new value
 * while cost settlement, safety, and billing stayed on the boot value (e.g.
 * reserve and settle would disagree on price within one request). Activation
 * compares this against the boot config and refuses when hot reload is on.
 */
export function frozenPolicyFieldsFingerprint(config: ModelgovConfig): string {
  return JSON.stringify({
    pricing: config.pricing ?? null,
    retry: config.routing?.retry ?? null,
    injectionModel: config.safety?.injectionModel ?? null,
    billingMode: config.billing?.mode ?? null,
    meterEventName: config.billing?.stripe?.meterEventName ?? null,
  });
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
    status: row.status,
    proposedBy: row.proposed_by ?? undefined,
    reviewedBy: row.reviewed_by ?? undefined,
    reviewedAt: row.reviewed_at?.toISOString(),
  };
}

const META_FIELDS =
  "id, created_at, author, note, checksum, active, activated_at, status, proposed_by, reviewed_by, reviewed_at";

/**
 * Validate and store a new (inactive) policy version. Throws PolicyConfigError
 * (mapped to 400 by the caller) if the YAML doesn't parse/validate — an invalid
 * version can never enter the store.
 */
const DEFAULT_TENANT = "default";

export async function saveConfigVersion(
  pool: Pool,
  input: {
    yaml: string;
    author?: string;
    note?: string;
    tenantId?: string;
    /** When true, the version is born `proposed` and needs a separate approval
     *  before it can be activated (two-person rule). Default: born `approved`. */
    approvalRequired?: boolean;
  },
  audit?: (record: ConfigVersionRecord) => AuditEvent,
): Promise<ConfigVersionRecord> {
  parseConfig(input.yaml, parseOptions()); // throws on invalid config
  const checksum = createHash("sha256").update(input.yaml).digest("hex");
  const tenantId = input.tenantId ?? DEFAULT_TENANT;
  const status: PolicyVersionStatus = input.approvalRequired ? "proposed" : "approved";
  // proposed_by is who authored a version awaiting approval — the self-approval
  // guard compares the approver against it, so record it only in that mode.
  const proposedBy = input.approvalRequired ? (input.author ?? null) : null;
  const insert = async (db: Queryable): Promise<ConfigVersionRecord> => {
    const { rows } = await db.query<ConfigVersionDbRow>(
      `INSERT INTO config_versions (tenant_id, author, note, yaml_text, checksum, status, proposed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${META_FIELDS}`,
      [tenantId, input.author ?? null, input.note ?? null, input.yaml, checksum, status, proposedBy],
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
): Promise<{ record: ConfigVersionRecord; config: ModelgovConfig; yaml: string } | null> {
  const { rows } = await scoped(pool, tenantId, (db) =>
    db.query<ConfigVersionDbRow>(
      `SELECT ${META_FIELDS}, yaml_text FROM config_versions WHERE active AND tenant_id = $1 LIMIT 1`,
      [tenantId],
    ),
  );
  const row = rows[0];
  if (!row || !row.yaml_text) return null;
  return { record: rowToRecord(row), config: parseConfig(row.yaml_text, parseOptions()), yaml: row.yaml_text };
}

/** Discriminated outcome so the route can map each failure to the right status
 *  (404 for unknown/foreign id; 409 for the state-machine and hot-reload cases). */
export type ActivateResult =
  | { ok: true; record: ConfigVersionRecord }
  | {
      ok: false;
      reason: "not_found" | "not_approved" | "not_reviewed" | "conflict" | "requires_restart";
    };

/**
 * Activate a stored version (this is also how rollback works — activate a prior
 * id). Re-validates the target before flipping. Returns `not_found` if the id is
 * unknown or belongs to another tenant, and `not_approved` if the version is not
 * in the `approved` state (the two-person rule — no effect when approval is off,
 * since saves are then born `approved`). Atomic: deactivate-all then
 * activate-one inside one transaction so the single-active invariant holds.
 *
 * `opts.requireReviewed` (set when POLICY_APPROVAL_REQUIRED is on) additionally
 * rejects versions that carry the `approved` status WITHOUT an actual review
 * (reviewed_by null) — i.e. versions born `approved` before approval was enabled.
 * Otherwise the two-person rule is trivially bypassable by activating any such
 * pre-existing draft. `opts.frozenGuard` refuses (with hot reload on) a version
 * that changes a boot-only field, so it can't half-apply.
 */
export async function activateConfigVersion(
  pool: Pool,
  id: string,
  expectedTenantId?: string,
  audit?: (record: ConfigVersionRecord) => AuditEvent,
  opts?: { requireReviewed?: boolean; frozenGuard?: { bootFingerprint: string } },
): Promise<ActivateResult> {
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
    const target = await client.query<{
      yaml_text: string;
      tenant_id: string;
      status: PolicyVersionStatus;
      reviewed_by: string | null;
    }>(
      "SELECT yaml_text, tenant_id, status, reviewed_by FROM config_versions WHERE id = $1 FOR UPDATE",
      [id],
    );
    const yaml = target.rows[0]?.yaml_text;
    const tenantId = target.rows[0]?.tenant_id;
    const status = target.rows[0]?.status;
    const reviewedBy = target.rows[0]?.reviewed_by;
    // Tenant isolation: a caller may only activate versions in its own tenant.
    if (!yaml || !tenantId || (expectedTenantId != null && tenantId !== expectedTenantId)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    // Two-person rule: only an approved version may go live.
    if (status !== "approved") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_approved" };
    }
    // When approval is required, an `approved` status alone is not enough: a
    // version born `approved` before the rule was enabled (or backfilled by the
    // approval migration) never had a second operator sign off. Require an actual
    // review, or the rule is bypassable via any pre-existing draft.
    if (opts?.requireReviewed && !reviewedBy) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_reviewed" };
    }
    const config = parseConfig(yaml, parseOptions()); // never activate an unparseable version
    // Hot-reload safety: a version that changes a boot-only field (pricing, retry,
    // injection model, billing mode) cannot be applied without a restart. Refuse
    // rather than half-apply it (see frozenPolicyFieldsFingerprint).
    if (opts?.frozenGuard && frozenPolicyFieldsFingerprint(config) !== opts.frozenGuard.bootFingerprint) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "requires_restart" };
    }
    // Deactivate only this tenant's currently-active version.
    await client.query("UPDATE config_versions SET active = false WHERE active AND tenant_id = $1", [tenantId]);
    const { rows } = await client.query<ConfigVersionDbRow>(
      `UPDATE config_versions SET active = true, activated_at = now()
       WHERE id = $1 RETURNING ${META_FIELDS}`,
      [id],
    );
    const record = rows[0] ? rowToRecord(rows[0]) : null;
    if (!record) {
      // The FOR UPDATE row existed, so this can only be an RLS visibility gap;
      // treat it as not-found rather than committing a no-op activation.
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    if (audit) await appendAuditInTransaction(client, audit(record));
    // Tell every replica (including this one) to drop its cached policy for this
    // tenant so the activation applies without a restart. NOTIFY is transactional
    // — it fires on COMMIT and is discarded on ROLLBACK, so a listener never sees
    // an activation that didn't take. No-op when no one is LISTENing.
    await client.query("SELECT pg_notify($1, $2)", [POLICY_ACTIVATED_CHANNEL, tenantId]);
    await client.query("COMMIT");
    return { ok: true, record };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // Two concurrent activations of different versions can both pass their
    // FOR UPDATE lookups (they lock different rows) and then collide on the
    // per-tenant single-active partial unique index. Surface that as a 409 the
    // caller can retry, not a raw 500.
    if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
      return { ok: false, reason: "conflict" };
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Discriminated outcome of an approve/reject review. */
export type ReviewResult =
  | { ok: true; record: ConfigVersionRecord }
  | { ok: false; reason: "not_found" | "not_proposed" | "self_approval" };

/**
 * Approve or reject a `proposed` version (the two-person rule). Enforces, inside
 * one locked transaction, that: the version exists in the caller's tenant; it is
 * still `proposed` (not already decided or activated); and — for approval — the
 * reviewer is a DIFFERENT operator than the proposer. Rejection has no
 * self-review restriction (an author may withdraw their own proposal).
 */
export async function reviewConfigVersion(
  pool: Pool,
  input: {
    id: string;
    decision: "approved" | "rejected";
    reviewer: string;
    /**
     * All identities the reviewer is known by — the stable id AND the display
     * name. The self-approval check matches `proposed_by` against ANY of them, so
     * a proposal stored under the old name-based identity (before the stable-id
     * change) still can't be self-approved by the same operator now identified by
     * its id. Defaults to `[reviewer]`.
     */
    reviewerAliases?: readonly string[];
    tenantId?: string;
  },
  audit?: (record: ConfigVersionRecord) => AuditEvent,
): Promise<ReviewResult> {
  const expectedTenantId = input.tenantId ?? DEFAULT_TENANT;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (rlsEnabled) {
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [expectedTenantId]);
    }
    const target = await client.query<{ tenant_id: string; status: PolicyVersionStatus; proposed_by: string | null }>(
      "SELECT tenant_id, status, proposed_by FROM config_versions WHERE id = $1 FOR UPDATE",
      [input.id],
    );
    const row = target.rows[0];
    if (!row || row.tenant_id !== expectedTenantId) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    if (row.status !== "proposed") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_proposed" };
    }
    const reviewerAliases = input.reviewerAliases ?? [input.reviewer];
    if (input.decision === "approved" && row.proposed_by && reviewerAliases.includes(row.proposed_by)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "self_approval" };
    }
    const { rows } = await client.query<ConfigVersionDbRow>(
      `UPDATE config_versions SET status = $2, reviewed_by = $3, reviewed_at = now()
       WHERE id = $1 RETURNING ${META_FIELDS}`,
      [input.id, input.decision, input.reviewer],
    );
    const record = rows[0] ? rowToRecord(rows[0]) : null;
    if (!record) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    if (audit) await appendAuditInTransaction(client, audit(record));
    await client.query("COMMIT");
    return { ok: true, record };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
