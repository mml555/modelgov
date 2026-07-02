-- Track in-flight budget reservations so stale leases can be released after
-- worker crashes (aligned with IDEMPOTENCY_STALE_MS / RESERVATION_STALE_MS).

CREATE TABLE IF NOT EXISTS budget_reservation_leases (
  id              bigserial      PRIMARY KEY,
  user_id         text           NOT NULL,
  feature         text           NOT NULL,
  estimated_cost  numeric(14, 6) NOT NULL,
  caps            jsonb          NOT NULL,
  window_day      date           NOT NULL,
  window_month    date           NOT NULL,
  leased_at       timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS budget_reservation_leases_leased_at_idx
  ON budget_reservation_leases (leased_at);
