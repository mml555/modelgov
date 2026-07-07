-- Poison-row handling for the Stripe meter flush. Previously an unreportable
-- row (e.g. Stripe "No such customer" after deletion, or a bad meter name) stayed
-- reported_at IS NULL forever and, with the batch's ORDER BY created_at LIMIT,
-- permanently occupied the head of every flush batch — once enough accumulated,
-- newer usage was never reported (silent revenue loss). Track delivery attempts
-- and a backoff so the flush skips repeatedly-failing rows and the retention
-- sweep can prune the ones that can never succeed.

ALTER TABLE meter_events
  ADD COLUMN IF NOT EXISTS attempts        integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error      text,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();

-- Pending scan: unreported rows whose backoff has elapsed, oldest first.
CREATE INDEX IF NOT EXISTS meter_events_pending_idx
  ON meter_events (next_attempt_at)
  WHERE reported_at IS NULL;
