-- Token-based limiting: track token usage alongside USD so budgets can cap
-- tokens, not just cost. Mirrors used_usd / reserved_usd. bigint holds large
-- monthly token totals.

ALTER TABLE budget_counters ADD COLUMN IF NOT EXISTS used_tokens     bigint NOT NULL DEFAULT 0;
ALTER TABLE budget_counters ADD COLUMN IF NOT EXISTS reserved_tokens bigint NOT NULL DEFAULT 0;

-- The stale-reservation sweep must free reserved tokens too, so the lease
-- records how many were held.
ALTER TABLE budget_reservation_leases ADD COLUMN IF NOT EXISTS estimated_tokens bigint NOT NULL DEFAULT 0;
