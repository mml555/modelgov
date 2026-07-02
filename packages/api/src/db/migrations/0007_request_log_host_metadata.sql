-- Host-app metadata for operator correlation (non-authoritative; logs/traces only).

ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS host_metadata jsonb;

CREATE INDEX IF NOT EXISTS request_logs_host_metadata_gin_idx
  ON request_logs USING gin (host_metadata);
