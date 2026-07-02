-- Reservation leases for hierarchical budgets (mirrors budget_reservation_leases
-- for the flat path). A lease records a live path reservation so a worker crash
-- between reserve and settle/release doesn't strand reserved_usd on the node
-- counters — the maintenance sweep releases stale leases.

CREATE TABLE IF NOT EXISTS budget_node_leases (
  id            bigserial     PRIMARY KEY,
  entries       jsonb         NOT NULL,   -- [{ nodeId, windowStart }, ...]
  amount_usd    numeric(14, 6) NOT NULL,
  request_delta integer        NOT NULL,
  leased_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS budget_node_leases_leased_at_idx ON budget_node_leases (leased_at);
