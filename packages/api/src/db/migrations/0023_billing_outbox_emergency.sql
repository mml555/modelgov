-- Billing credit wallets, meter-event idempotency, durable webhooks, emergency pause.

CREATE TABLE IF NOT EXISTS billing_accounts (
  tenant_id            text           NOT NULL DEFAULT '',
  user_id              text           NOT NULL,
  stripe_customer_id   text,
  user_type            text,
  credits_usd          numeric(14, 6) NOT NULL DEFAULT 0,
  credits_reserved_usd numeric(14, 6) NOT NULL DEFAULT 0,
  updated_at           timestamptz    NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS billing_accounts_stripe_customer_idx
  ON billing_accounts (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS meter_events (
  request_id   text           PRIMARY KEY,
  tenant_id    text           NOT NULL DEFAULT '',
  user_id      text           NOT NULL,
  feature      text           NOT NULL,
  cost_usd     numeric(14, 6) NOT NULL,
  reported_at  timestamptz,
  stripe_event_id text,
  created_at   timestamptz    NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_outbox (
  id               bigserial      PRIMARY KEY,
  event_type       text           NOT NULL,
  payload          jsonb          NOT NULL,
  destination_url  text           NOT NULL,
  secret           text,
  attempts         integer        NOT NULL DEFAULT 0,
  max_attempts     integer        NOT NULL DEFAULT 5,
  next_attempt_at  timestamptz    NOT NULL DEFAULT now(),
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_outbox_pending_idx
  ON webhook_outbox (next_attempt_at)
  WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS system_flags (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotency for Stripe webhook processing: Stripe delivers events at least
-- once and operators can replay them, so a credit grant is keyed by event id
-- and applied at most once (recorded in the same transaction as the top-up).
CREATE TABLE IF NOT EXISTS stripe_processed_events (
  event_id     text        PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);
