-- Tenant stamp on idempotency rows so GDPR erasure can scope to a tenant partition.
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS tenant_id text;

CREATE INDEX IF NOT EXISTS idempotency_keys_tenant_user_idx
  ON idempotency_keys (tenant_id, user_id)
  WHERE tenant_id IS NOT NULL;
