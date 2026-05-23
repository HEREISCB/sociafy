-- Credit-ledger system. Paste into Supabase SQL Editor (Database → SQL Editor
-- → New query) and run. Idempotent: safe to re-run.
--
-- Adds the billing primitives the pricing model (docs/pricing.md) assumes:
--   1. tier + credit_cycle_start columns on profiles for subscription state.
--   2. credit_ledger — append-only signed-credit table. Every billable event
--      is a row; balance = SUM(credits) per user.
--   3. Backfill: grant 2,000 starter credits as a signup_bonus to every
--      existing profile that doesn't have one yet, so users mid-flight don't
--      suddenly get out_of_credits.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'starter',
  ADD COLUMN IF NOT EXISTS credit_cycle_start timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS public.credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  kind text NOT NULL,
  action text,
  credits integer NOT NULL,
  meta jsonb DEFAULT '{}'::jsonb,
  related_ledger_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_ledger_user_created_idx
  ON public.credit_ledger (user_id, created_at);
CREATE INDEX IF NOT EXISTS credit_ledger_user_kind_idx
  ON public.credit_ledger (user_id, kind);

-- Add credit-ledger link on video_jobs so the polling endpoint can refund
-- a failed generation. Null for legacy rows from before the credit system.
ALTER TABLE public.video_jobs
  ADD COLUMN IF NOT EXISTS credit_ledger_id uuid,
  ADD COLUMN IF NOT EXISTS credits_charged integer;

-- Backfill signup bonus for existing users who never received one. The 2,000
-- credits matches the Starter-tier allocation so every existing user has at
-- least one full month's budget to keep going.
INSERT INTO public.credit_ledger (user_id, kind, action, credits, meta)
SELECT p.id, 'signup_bonus', NULL, 2000,
       jsonb_build_object('note', 'backfill grant from 0004 migration')
FROM public.profiles p
WHERE NOT EXISTS (
  SELECT 1 FROM public.credit_ledger l
  WHERE l.user_id = p.id
    AND l.kind IN ('signup_bonus', 'monthly_grant', 'topup', 'admin_grant')
);
