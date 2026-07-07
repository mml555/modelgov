import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";

type Queryable = Pick<Pool, "query">;

const KEY_TOKEN_PREFIX = "sk-modelgov-";
/** Chars of the full secret kept for non-secret display/identification. */
const DISPLAY_PREFIX_LEN = KEY_TOKEN_PREFIX.length + 8;

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  projectId?: string;
  environment?: string;
  allowedUserTypes?: string[];
  allowedUserIds?: string[];
  tenantId?: string;
  budgetNodeId?: string;
  createdAt: string;
  createdBy?: string;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

export interface CreateApiKeyInput {
  name: string;
  permissions?: string[];
  projectId?: string;
  environment?: string;
  allowedUserTypes?: string[];
  allowedUserIds?: string[];
  tenantId?: string;
  budgetNodeId?: string;
  expiresAt?: string;
  createdBy?: string;
}

/**
 * A newly minted (or rotated) key: the metadata `record` and the plaintext
 * `secret` are kept as SEPARATE fields, never a single object with the secret
 * spread in. This keeps the secret out of any object that callers pass to audit
 * logging (whose row hash would otherwise pull in the credential) — the audit
 * `actor`/`target`/`metadata` are built from `record`, and `secret` is only ever
 * returned to the caller once, in the HTTP response.
 */
export interface IssuedApiKey {
  record: ApiKeyRecord;
  /** Raw secret — shown once, never retrievable again. */
  secret: string;
}

interface ApiKeyDbRow {
  id: string;
  name: string;
  key_prefix: string;
  permissions: string[] | null;
  project_id: string | null;
  environment: string | null;
  allowed_user_types: string[] | null;
  allowed_user_ids: string[] | null;
  tenant_id: string | null;
  budget_node_id: string | null;
  created_at: Date;
  created_by: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

const SELECT_FIELDS = `
  id, name, key_prefix, permissions, project_id, environment,
  allowed_user_types, allowed_user_ids, tenant_id, budget_node_id,
  created_at, created_by, expires_at, revoked_at, last_used_at
`;

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Generate a fresh secret plus its stored hash/prefix. */
export function generateApiKeySecret(): {
  secret: string;
  keyHash: string;
  keyPrefix: string;
} {
  const secret = KEY_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return {
    secret,
    keyHash: hashApiKey(secret),
    keyPrefix: secret.slice(0, DISPLAY_PREFIX_LEN),
  };
}

function rowToRecord(row: ApiKeyDbRow): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    permissions: row.permissions ?? [],
    projectId: row.project_id ?? undefined,
    environment: row.environment ?? undefined,
    allowedUserTypes: row.allowed_user_types ?? undefined,
    allowedUserIds: row.allowed_user_ids ?? undefined,
    tenantId: row.tenant_id ?? undefined,
    budgetNodeId: row.budget_node_id ?? undefined,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by ?? undefined,
    expiresAt: row.expires_at?.toISOString(),
    revokedAt: row.revoked_at?.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString(),
  };
}

export async function createApiKey(
  pool: Queryable,
  input: CreateApiKeyInput,
): Promise<IssuedApiKey> {
  const { secret, keyHash, keyPrefix } = generateApiKeySecret();
  const permissions = input.permissions ?? ["chat:create"];
  const { rows } = await pool.query<ApiKeyDbRow>(
    `INSERT INTO api_keys
       (name, key_hash, key_prefix, permissions, project_id, environment,
        allowed_user_types, allowed_user_ids, tenant_id, budget_node_id,
        expires_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
     RETURNING ${SELECT_FIELDS}`,
    [
      input.name,
      keyHash,
      keyPrefix,
      JSON.stringify(permissions),
      input.projectId ?? null,
      input.environment ?? null,
      input.allowedUserTypes ? JSON.stringify(input.allowedUserTypes) : null,
      input.allowedUserIds ? JSON.stringify(input.allowedUserIds) : null,
      input.tenantId ?? null,
      input.budgetNodeId ?? null,
      input.expiresAt ?? null,
      input.createdBy ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("api key insert returned no row");
  return { record: rowToRecord(row), secret };
}

export async function listApiKeys(
  pool: Queryable,
  opts: { includeRevoked?: boolean; projectId?: string; tenantId?: string } = {},
): Promise<ApiKeyRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (!opts.includeRevoked) conditions.push("revoked_at IS NULL");
  if (opts.projectId) {
    values.push(opts.projectId);
    conditions.push(`project_id = $${values.length}`);
  }
  // A tenant-scoped admin only ever sees its own tenant's keys.
  if (opts.tenantId !== undefined) {
    values.push(opts.tenantId);
    conditions.push(`tenant_id = $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query<ApiKeyDbRow>(
    `SELECT ${SELECT_FIELDS} FROM api_keys ${where} ORDER BY created_at DESC`,
    values,
  );
  return rows.map(rowToRecord);
}

/**
 * Fetch a key by id, optionally constrained to a tenant. A tenant-scoped admin
 * passes its `tenantId` so it can never read (or, via rotate/revoke, disrupt)
 * another tenant's keys; a root admin (undefined tenant) sees all.
 */
export async function getApiKeyById(
  pool: Queryable,
  id: string,
  tenantId?: string,
): Promise<ApiKeyRecord | null> {
  const { rows } =
    tenantId === undefined
      ? await pool.query<ApiKeyDbRow>(`SELECT ${SELECT_FIELDS} FROM api_keys WHERE id = $1`, [id])
      : await pool.query<ApiKeyDbRow>(
          `SELECT ${SELECT_FIELDS} FROM api_keys WHERE id = $1 AND tenant_id = $2`,
          [id, tenantId],
        );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Revoke a key. Idempotent — returns false if the id is unknown (in the caller's tenant). */
export async function revokeApiKey(
  pool: Queryable,
  id: string,
  tenantId?: string,
): Promise<boolean> {
  const scope = tenantId === undefined ? "" : " AND tenant_id = $2";
  const params = tenantId === undefined ? [id] : [id, tenantId];
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND revoked_at IS NULL${scope}`,
    params,
  );
  if (rowCount && rowCount > 0) return true;
  // Distinguish "already revoked" (still a success) from "unknown id" — but only
  // within the caller's tenant, so a cross-tenant id looks like "unknown".
  const exists = await pool.query(
    `SELECT 1 FROM api_keys WHERE id = $1${scope}`,
    params,
  );
  return (exists.rowCount ?? 0) > 0;
}

/**
 * Rotate a key: mint a new secret for the same logical key (id + scoping
 * preserved), invalidating the previous secret immediately. Returns the new
 * plaintext once, or null if the id is unknown or already revoked.
 */
export async function rotateApiKey(
  pool: Queryable,
  id: string,
  tenantId?: string,
): Promise<IssuedApiKey | null> {
  const { secret, keyHash, keyPrefix } = generateApiKeySecret();
  const scope = tenantId === undefined ? "" : " AND tenant_id = $4";
  const params =
    tenantId === undefined ? [id, keyHash, keyPrefix] : [id, keyHash, keyPrefix, tenantId];
  const { rows } = await pool.query<ApiKeyDbRow>(
    `UPDATE api_keys
       SET key_hash = $2, key_prefix = $3
     WHERE id = $1 AND revoked_at IS NULL${scope}
     RETURNING ${SELECT_FIELDS}`,
    params,
  );
  return rows[0] ? { record: rowToRecord(rows[0]), secret } : null;
}

/** Resolved principal for the auth layer, or null if no active key matches. */
export interface ActiveApiKey {
  id: string;
  name: string;
  permissions: string[];
  projectId?: string;
  environment?: string;
  allowedUserTypes?: string[];
  allowedUserIds?: string[];
  tenantId?: string;
  budgetNodeId?: string;
  expiresAt?: string;
}

/**
 * Look up an active (non-revoked, non-expired) key by its raw secret. Expiry is
 * enforced in SQL so a clock check isn't needed in the hot path.
 */
export async function findActiveApiKeyByToken(
  pool: Pool,
  token: string,
): Promise<ActiveApiKey | null> {
  const keyHash = hashApiKey(token);
  const { rows } = await pool.query<ApiKeyDbRow>(
    `SELECT ${SELECT_FIELDS} FROM api_keys
     WHERE key_hash = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())`,
    [keyHash],
  );
  const row = rows[0];
  if (!row) return null;
  // Best-effort last-used stamp; never block auth on it.
  void pool
    .query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [row.id])
    .catch(() => {});
  return {
    id: row.id,
    name: row.name,
    permissions: row.permissions ?? [],
    projectId: row.project_id ?? undefined,
    environment: row.environment ?? undefined,
    allowedUserTypes: row.allowed_user_types ?? undefined,
    allowedUserIds: row.allowed_user_ids ?? undefined,
    tenantId: row.tenant_id ?? undefined,
    budgetNodeId: row.budget_node_id ?? undefined,
    expiresAt: row.expires_at?.toISOString(),
  };
}
