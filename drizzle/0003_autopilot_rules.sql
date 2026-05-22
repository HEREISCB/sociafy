-- Adds the autopilot permission matrix to agent_settings.
-- Paste into Supabase SQL Editor (Database → SQL Editor → New query) and run.
-- Idempotent: safe to re-run.
--
-- Why: until now, autopilot published the same draft to ALL connected
-- platforms and capped only the total weekly count. The user now needs
-- finer control:
--   - enabled_platforms        — which platforms autopilot may post to
--   - posts_per_week_by_platform — cap per platform (e.g. X:5, LinkedIn:3)
--   - posts_per_week_by_content_type — text vs image vs video mix
--
-- All defaults are safe — empty enabled_platforms means "fall back to
-- all connected platforms" (legacy behavior); empty per-platform caps
-- mean "no per-platform limit, just respect cadence_per_week"; default
-- content-type mix is 4 text / 0 image / 0 video (matches today).

ALTER TABLE public.agent_settings
  ADD COLUMN IF NOT EXISTS enabled_platforms              jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS posts_per_week_by_platform     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS posts_per_week_by_content_type jsonb NOT NULL DEFAULT '{"text":4,"image":0,"video":0}'::jsonb;
