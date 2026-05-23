-- Flip the default of agent_settings.auto_publish_threshold from 90 → 101.
-- 101 is unreachable (AI scores top out at 100), so it means "drafts only —
-- never auto-publish; user reviews every draft."
--
-- Why: original default of 90 was too aggressive for new users. The Plan
-- step in onboarding now asks them to explicitly opt into auto-publishing.
--
-- Existing rows are left untouched so users who already configured a
-- threshold keep their setting.
-- Paste into Supabase SQL Editor and run. Idempotent.

ALTER TABLE public.agent_settings
  ALTER COLUMN auto_publish_threshold SET DEFAULT 101;
