-- 0020 — Edit history for AI-designed motion graphics.
--
-- One row per motion-claude video job: the original render (root_job_id =
-- its own id) and each edit of it (parent_job_id = the version it revised,
-- root_job_id = the original). `segments` is the worker's beat list for that
-- render, shape = MotionSegment in lib/ai/motionAi.ts — the edit timeline.
--
-- Its own table, not a video_jobs column: drizzle selects every column it
-- knows about, so a new video_jobs column would break every video poll until
-- this runs. Before it runs only the edit feature is affected (finalize writes
-- here best-effort and never blocks a completion on it).
--
-- Apply via the Supabase SQL editor. Additive and idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.motion_versions (
  video_job_id uuid PRIMARY KEY,
  root_job_id uuid NOT NULL,
  parent_job_id uuid,
  segment_id text,
  instruction text,
  segments jsonb,
  poster_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS motion_versions_root_idx ON public.motion_versions (root_job_id);
