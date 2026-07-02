-- Tenant partition for the admin audit log so a tenant-scoped admin only reads
-- its own tenant's privileged-mutation trail (key create/rotate/revoke, policy
-- changes). Previously listAudit filtered by action/actor only, exposing every
-- tenant's admin activity to any audit:read key. tenant_id is '' for
-- root/untenanted actions and is folded into the row hash (see computeRowHash),
-- so relabelling a row's tenant breaks the chain like any other tamper.
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS admin_audit_log_tenant_idx
  ON admin_audit_log (tenant_id)
  WHERE tenant_id <> '';
