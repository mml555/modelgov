-- The time-window read paths (/v1/usage/summary, /v1/usage/transactions,
-- getRecentRequestStats) all scan request_logs by `created_at >= since` within a
-- tenant partition. A (tenant_id, created_at) btree lets the planner seek to the
-- caller's tenant slice (including the default NULL-tenant partition) and range-
-- scan the window, instead of scanning the whole table and aggregating before the
-- LIMIT can apply. The pre-existing (tenant_id, correlation_id) index serves the
-- /v1/requests?correlationId equality lookup but NOT these range aggregates.
CREATE INDEX IF NOT EXISTS request_logs_tenant_created_idx
  ON request_logs (tenant_id, created_at);
