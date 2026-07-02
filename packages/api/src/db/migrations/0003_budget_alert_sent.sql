-- Track budget alert webhooks sent per scope/window (dedupe across replicas).

CREATE TABLE IF NOT EXISTS budget_alert_sent (
  scope         text         NOT NULL,
  window_start  date         NOT NULL,
  alert_kind    text         NOT NULL DEFAULT 'threshold',
  sent_at       timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, window_start, alert_kind)
);
