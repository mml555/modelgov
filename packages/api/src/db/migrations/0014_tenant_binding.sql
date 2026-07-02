-- Tenant binding for multi-tenancy (see docs/design/multi-tenancy.md).
--
-- Bind API keys to a tenant and (optionally) to a leaf budget node, so a key's
-- requests are scoped and billed to its tenant/node without the client passing
-- ids. Give policy versions a tenant so each tenant has its own policy lineage.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS budget_node_id bigint;

ALTER TABLE config_versions ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';

-- One active policy version PER TENANT (was one globally).
DROP INDEX IF EXISTS config_versions_one_active_idx;
CREATE UNIQUE INDEX IF NOT EXISTS config_versions_one_active_per_tenant_idx
  ON config_versions (tenant_id)
  WHERE active;
