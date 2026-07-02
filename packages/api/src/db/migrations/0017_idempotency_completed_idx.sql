-- Speed up the maintenance sweep that prunes completed idempotency replays.
CREATE INDEX IF NOT EXISTS idempotency_keys_completed_at_idx
  ON idempotency_keys (completed_at)
  WHERE status = 'completed';
