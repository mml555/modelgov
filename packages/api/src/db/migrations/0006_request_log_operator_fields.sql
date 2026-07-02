-- Operator visibility: stable reason codes and requested model class on audit rows.

ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS reason_code text,
  ADD COLUMN IF NOT EXISTS requested_model_class text;

CREATE INDEX IF NOT EXISTS request_logs_reason_code_idx
  ON request_logs (reason_code)
  WHERE reason_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS request_logs_status_created_idx
  ON request_logs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS request_logs_feature_created_idx
  ON request_logs (feature, created_at DESC);
