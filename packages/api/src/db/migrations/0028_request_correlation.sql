-- Cost attribution: a first-class correlation key so many gateway calls (and
-- externally-ingested non-LLM cost) can be rolled up under one business
-- transaction. Sourced from the caller's reused `x-request-id` (see
-- docs/design/cost-attribution.md). Nullable + additive: existing rows keep
-- correlation_id = NULL and are simply absent from transaction rollups.
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS correlation_id text;

-- Partial composite btree: the transaction rollup and the /v1/requests filter
-- both look up by (tenant partition, correlation_id). Partial on NOT NULL keeps
-- the index off every pre-migration row and every future row where the caller
-- opted out of grouping via a fresh per-call id... (those still get a value, so
-- the partial mainly excludes legacy NULLs).
CREATE INDEX IF NOT EXISTS request_logs_correlation_idx
  ON request_logs (tenant_id, correlation_id)
  WHERE correlation_id IS NOT NULL;
