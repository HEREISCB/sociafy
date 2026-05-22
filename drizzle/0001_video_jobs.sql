-- Adds the video_jobs table for async PiAPI Seedance generations.
-- Paste into Supabase SQL Editor (Database → SQL Editor → New query) and run.
-- Idempotent: safe to re-run.
--
-- Why: video gen is async (30–120s). We submit a task to PiAPI, store the
-- task_id + user_id + params here, and the polling endpoint authorizes by
-- user_id, finalizes once Seedance reports Completed, and links the
-- resulting media_assets row via media_asset_id.

-- =====================================================
-- video_jobs
-- =====================================================
CREATE TABLE IF NOT EXISTS public.video_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             text NOT NULL,
  provider            text NOT NULL,                 -- e.g. 'piapi-seedance-2' / 'piapi-seedance-2-fast'
  provider_task_id    text NOT NULL,                 -- PiAPI task_id
  status              text NOT NULL DEFAULT 'pending', -- pending | completed | failed
  prompt              text NOT NULL,
  rewritten_prompt    text,
  duration_sec        integer NOT NULL,
  aspect              text NOT NULL,                 -- '9:16' | '1:1' | '16:9'
  quality             text NOT NULL,                 -- '480p' | '720p' | '1080p'
  gen_mode            text NOT NULL,                 -- 'text' | 'image-to-video' | 'reference' | 'audio-driven'
  media_asset_id      uuid,                          -- null until completed → R2 + media_assets row
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_jobs_user_idx ON public.video_jobs (user_id);
CREATE INDEX IF NOT EXISTS video_jobs_task_idx ON public.video_jobs (provider_task_id);
