-- Tenant dimension for the flat budget counters.
--
-- Previously budget_counters was keyed (scope, project_id, key, window_start)
-- with global_monthly pinned to project_id = '' for the WHOLE deployment. Under
-- multi-tenant use every tenant incremented the one global row, so one tenant
-- exhausting its global monthly cap blocked every other tenant (cross-tenant
-- DoS) and per-tenant spend was corrupted. user_daily / feature_monthly rows
-- likewise collided whenever two tenants shared a project_id.
--
-- tenant_id ('' = single-tenant / untenanted) joins the key so every tenant gets
-- its own counters, including its own global_monthly. The reservation lease
-- carries the same tenant so the stale-lease sweep releases the right rows.
ALTER TABLE budget_counters ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT '';
ALTER TABLE budget_counters DROP CONSTRAINT IF EXISTS budget_counters_pkey;
ALTER TABLE budget_counters ADD PRIMARY KEY (tenant_id, scope, project_id, key, window_start);

ALTER TABLE budget_reservation_leases ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT '';
