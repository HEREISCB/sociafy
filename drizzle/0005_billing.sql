-- Stripe linkage on profiles. Webhooks mirror Stripe's subscription state
-- into these columns; the app reads them locally instead of hitting Stripe
-- on every request.
-- Paste into Supabase SQL Editor (Database → SQL Editor → New query) and run.
-- Idempotent: safe to re-run.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS stripe_customer_id              text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id          text,
  ADD COLUMN IF NOT EXISTS subscription_status             text,
  ADD COLUMN IF NOT EXISTS subscription_current_period_end timestamptz;

CREATE INDEX IF NOT EXISTS profiles_stripe_customer_idx
  ON public.profiles (stripe_customer_id);
CREATE INDEX IF NOT EXISTS profiles_stripe_subscription_idx
  ON public.profiles (stripe_subscription_id);
