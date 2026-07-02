-- Stamp which policy produced each decision, so an operator can correlate a
-- request log to the exact config that was active (see the versioned policy
-- store). config_hash is the SHA-256 of the effective config; policy_version is
-- the config_versions id when the DB policy store is enabled, else 'file'.

ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS config_hash text;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS policy_version text;
