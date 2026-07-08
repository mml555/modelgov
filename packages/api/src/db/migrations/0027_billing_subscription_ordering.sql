-- Subscription webhook ordering guard + one-account-per-customer integrity.
--
-- last_subscription_event_at: the Stripe `event.created` (unix seconds) of the
-- most recently APPLIED customer.subscription.* event for this account. The
-- webhook handler skips any subscription event older than this, so a late-
-- redelivered `active` cannot re-upgrade an account that a later `deleted`
-- already downgraded (Stripe retries for ~3 days; dashboard resend does the same).
ALTER TABLE billing_accounts
  ADD COLUMN IF NOT EXISTS last_subscription_event_at bigint NOT NULL DEFAULT 0;

-- Enforce one billing account per Stripe customer id. Without this, a customer
-- id could map to accounts in multiple tenants, and subscription/invoice
-- webhooks would hit an arbitrary one (and a tenant that learns another's cus_…
-- id could claim it). Created only when the data is already clean, so an existing
-- deployment with duplicates still boots (with a warning) rather than failing the
-- migration; deduplicate to gain the constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'billing_accounts_stripe_customer_unique_idx'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM billing_accounts
      WHERE stripe_customer_id IS NOT NULL
      GROUP BY stripe_customer_id
      HAVING count(*) > 1
    ) THEN
      CREATE UNIQUE INDEX billing_accounts_stripe_customer_unique_idx
        ON billing_accounts (stripe_customer_id)
        WHERE stripe_customer_id IS NOT NULL;
    ELSE
      RAISE WARNING 'billing_accounts has duplicate stripe_customer_id values; skipping unique index. Deduplicate to enforce one-account-per-customer.';
    END IF;
  END IF;
END $$;
