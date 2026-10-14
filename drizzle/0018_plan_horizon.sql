-- 0018 — Planning engine: drafts get a proposed slot, settings get a horizon.
--
-- drafts.planned_at            when the plan wants this post to go out. Set when
--                              autopilot drafts it; becomes the scheduled_posts
--                              time on approve (or straight away in auto mode).
--                              Null for hand-made drafts and pre-plan rows.
-- agent_settings.plan_horizon_days
--                              how far ahead autopilot keeps the plan filled
--                              (7 or 30; enforced in lib/validation.ts).
-- agent_settings.plan_running_until
--                              lease for an in-flight plan run, so the cron and
--                              "Generate" never draft (and charge) twice.
--
-- Apply via the Supabase SQL editor. Additive and idempotent: safe to re-run.

ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS planned_at timestamptz;

ALTER TABLE public.agent_settings
  ADD COLUMN IF NOT EXISTS plan_horizon_days int NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS plan_running_until timestamptz;

CREATE INDEX IF NOT EXISTS drafts_user_planned_idx
  ON public.drafts (user_id, planned_at) WHERE planned_at IS NOT NULL;
