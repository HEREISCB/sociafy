-- 0013 — weekly credit cap on agent_settings.
--
-- Why: autopilot spent credits with no ceiling the user controlled. This is the
-- most it may spend in any trailing 7 days; lib/agent/run.ts skips the cron
-- draft once one more would cross it. Null = no cap (every existing user).
--
-- Apply via the Supabase SQL editor (db:push is unreliable for this project).
-- Idempotent: safe to re-run.

ALTER TABLE public.agent_settings
  ADD COLUMN IF NOT EXISTS weekly_credit_cap integer;
