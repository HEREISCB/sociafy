-- 0021 — Hybrid videos: AI footage composited inside an AI motion graphic.
--
-- One row per footage render. parent_job_id = the user-facing motion-claude
-- video_jobs row (charged the full hybrid price once, status 'footage' while
-- it waits); child_job_id = the internal footage video_jobs row
-- (credits_charged 0). `spec` = HybridSpec in lib/media/hybridJob.ts (audio,
-- clip placement, fallback price).
--
-- Its own table, not a video_jobs column: drizzle selects every column it
-- knows about. Before this runs only hybrid generation is affected.
--
-- Apply via the Supabase SQL editor. Additive and idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.hybrid_parts (
  child_job_id uuid PRIMARY KEY,
  parent_job_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'footage',
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hybrid_parts_parent_idx ON public.hybrid_parts (parent_job_id);
