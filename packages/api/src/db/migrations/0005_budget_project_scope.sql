-- Partition user_daily and feature_monthly counters by project_id.
-- Global monthly remains deployment-wide (project_id = '').

ALTER TABLE budget_counters
  ADD COLUMN IF NOT EXISTS project_id text NOT NULL DEFAULT '';

ALTER TABLE budget_reservation_leases
  ADD COLUMN IF NOT EXISTS project_id text NOT NULL DEFAULT '';

ALTER TABLE budget_counters DROP CONSTRAINT IF EXISTS budget_counters_pkey;
ALTER TABLE budget_counters
  ADD PRIMARY KEY (scope, project_id, key, window_start);
