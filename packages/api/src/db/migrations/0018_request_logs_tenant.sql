-- Tenant partition for request audit rows (multi-tenant read scoping).
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS tenant_id text;

CREATE INDEX IF NOT EXISTS request_logs_tenant_idx
  ON request_logs (tenant_id)
  WHERE tenant_id IS NOT NULL;
