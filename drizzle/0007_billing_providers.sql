
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS billing_country           text,
  ADD COLUMN IF NOT EXISTS billing_currency          text,
  ADD COLUMN IF NOT EXISTS payment_provider          text,
  ADD COLUMN IF NOT EXISTS razorpay_customer_id      text,
  ADD COLUMN IF NOT EXISTS razorpay_subscription_id  text,
  ADD COLUMN IF NOT EXISTS pending_tier_change_to    text,
  ADD COLUMN IF NOT EXISTS pending_tier_change_at    timestamptz;

CREATE INDEX IF NOT EXISTS profiles_razorpay_customer_idx
  ON public.profiles (razorpay_customer_id);
CREATE INDEX IF NOT EXISTS profiles_razorpay_subscription_idx
  ON public.profiles (razorpay_subscription_id);
