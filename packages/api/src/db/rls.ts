import type { Pool } from "pg";

/**
 * Optional Postgres row-level security for tenant isolation on `config_versions`
 * (see docs/design/multi-tenancy.md). This is defense-in-depth on top of the
 * app's existing `tenant_id` WHERE-scoping — NOT part of the auto-run migration
 * chain, because enabling it changes query results for non-owner DB roles.
 *
 * `ENABLE` (not `FORCE`) row level security means the table OWNER still bypasses
 * the policy, so existing single-role deploys are unaffected even after this is
 * applied. Isolation takes effect only when the app connects as a NON-OWNER role
 * that sets `app.current_tenant` per transaction (DB_RLS_ENABLED=true wires
 * that via withTenantContext). The policy is fail-closed: with no
 * `app.current_tenant` set, `current_setting(..., true)` is NULL and no rows
 * match.
 *
 * Idempotent: safe to run repeatedly.
 */
export const TENANT_RLS_SQL = `
ALTER TABLE config_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON config_versions;
CREATE POLICY tenant_isolation ON config_versions
  USING (tenant_id = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true));
`;

const DROP_TENANT_RLS_SQL = `
DROP POLICY IF EXISTS tenant_isolation ON config_versions;
ALTER TABLE config_versions DISABLE ROW LEVEL SECURITY;
`;

/** Install the config_versions tenant-isolation RLS policy. Idempotent. */
export async function applyTenantRls(pool: Pool): Promise<void> {
  await pool.query(TENANT_RLS_SQL);
}

/** Remove the config_versions tenant-isolation RLS policy. Idempotent. */
export async function dropTenantRls(pool: Pool): Promise<void> {
  await pool.query(DROP_TENANT_RLS_SQL);
}
