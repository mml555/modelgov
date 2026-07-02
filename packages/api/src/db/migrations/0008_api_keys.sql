-- DB-backed API key lifecycle (issue / scope / rotate / revoke) without redeploy.
--
-- Secrets are never stored in plaintext: only the SHA-256 hex digest (key_hash)
-- is persisted, alongside a short non-secret prefix for display/identification.
-- Static env keys (AI_GUARD_API_KEYS) remain supported for bootstrap; the DB
-- store is layered on top so operators can rotate/revoke live.

CREATE TABLE IF NOT EXISTS api_keys (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text          NOT NULL,
  -- Lowercase SHA-256 hex of the raw secret. Unique so a token maps to one key.
  key_hash           text          NOT NULL UNIQUE,
  -- Non-secret leading fragment (e.g. "sk-ai-guard-live-a1b2c3") for UI/audit.
  key_prefix         text          NOT NULL,
  permissions        jsonb         NOT NULL DEFAULT '["chat:create"]'::jsonb,
  project_id         text,
  environment        text,
  allowed_user_types jsonb,
  allowed_user_ids   jsonb,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  created_by         text,
  expires_at         timestamptz,
  revoked_at         timestamptz,
  last_used_at       timestamptz
);

-- Auth hot path looks up active keys by hash. A partial index keeps the working
-- set to non-revoked keys.
CREATE INDEX IF NOT EXISTS api_keys_active_hash_idx
  ON api_keys (key_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS api_keys_project_idx ON api_keys (project_id);
