-- Dynamic, versioned policy store.
--
-- Instead of a single ai-guard.yaml baked into the image, policy can be stored
-- here as immutable versions. Exactly one row is active at a time; activating a
-- new version is an auditable, reversible operation (rollback = activate a prior
-- version). Every version is validated before it can be saved.

CREATE TABLE IF NOT EXISTS config_versions (
  id           bigserial    PRIMARY KEY,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  author       text,
  note         text,
  yaml_text    text         NOT NULL,
  checksum     text         NOT NULL,
  active       boolean      NOT NULL DEFAULT false,
  activated_at timestamptz
);

-- At most one active version. A partial unique index enforces the invariant.
CREATE UNIQUE INDEX IF NOT EXISTS config_versions_one_active_idx
  ON config_versions ((active))
  WHERE active;
