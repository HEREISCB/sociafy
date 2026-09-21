-- 0014 — drafts.video_job_id.
--
-- Why: autopilot now makes video posts. A render takes minutes, so the draft is
-- written first and points at its video_jobs row; when the render lands,
-- lib/agent/media.ts attaches the clip, schedules the post if it qualifies, and
-- nulls this column. Null for every other draft.
--
-- Apply via the Supabase SQL editor (db:push is unreliable for this project).
-- Idempotent: safe to re-run.

ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS video_job_id uuid;

CREATE INDEX IF NOT EXISTS drafts_video_job_idx ON public.drafts (video_job_id) WHERE video_job_id IS NOT NULL;
