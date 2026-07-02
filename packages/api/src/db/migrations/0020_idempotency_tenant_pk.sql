-- Put tenant in the idempotency identity so two tenants that share a
-- (user_id, key) — both client-supplied, so collisions are expected, not rare —
-- cannot collide, replay each other's cached response body, or spuriously
-- 409/422 one another. Migration 0019 added tenant_id but left it informational:
-- the PK stayed (user_id, key) and the claim/replay lookups ignored the tenant.
--
-- tenant_id is normalized to '' (never NULL) so it can sit in the PRIMARY KEY:
-- '' is the single-tenant / untenanted bucket, matching how the repo now writes
-- params.tenantId ?? ''.
UPDATE idempotency_keys SET tenant_id = '' WHERE tenant_id IS NULL;
ALTER TABLE idempotency_keys ALTER COLUMN tenant_id SET DEFAULT '';
ALTER TABLE idempotency_keys ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE idempotency_keys DROP CONSTRAINT IF EXISTS idempotency_keys_pkey;
ALTER TABLE idempotency_keys ADD PRIMARY KEY (tenant_id, user_id, key);
