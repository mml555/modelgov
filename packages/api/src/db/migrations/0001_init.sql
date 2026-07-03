-- Initial Modelgov schema.

CREATE TABLE IF NOT EXISTS budget_counters (
  scope         text          NOT NULL,
  key           text          NOT NULL,
  window_start  date          NOT NULL,
  used_usd      numeric(14, 6) NOT NULL DEFAULT 0,
  reserved_usd  numeric(14, 6) NOT NULL DEFAULT 0,
  requests_used integer        NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key, window_start)
);

CREATE TABLE IF NOT EXISTS request_logs (
  id                 bigserial    PRIMARY KEY,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  project_id         text,
  environment        text,
  user_id            text,
  user_type          text,
  feature            text         NOT NULL,
  model_class        text,
  resolved_model     text,
  decision           text         NOT NULL,
  status             text         NOT NULL,
  estimated_cost_usd numeric(14, 6),
  actual_cost_usd    numeric(14, 6),
  input_tokens       integer,
  output_tokens      integer,
  pii_masked         boolean,
  injection_blocked  boolean,
  error              text,
  trace_tags         jsonb,
  safety_findings    jsonb
);

CREATE INDEX IF NOT EXISTS request_logs_created_at_idx ON request_logs (created_at);
CREATE INDEX IF NOT EXISTS request_logs_user_feature_idx ON request_logs (user_id, feature);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             text         PRIMARY KEY,
  user_id         text         NOT NULL,
  request_hash    text         NOT NULL,
  status          text         NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx ON idempotency_keys (created_at);
