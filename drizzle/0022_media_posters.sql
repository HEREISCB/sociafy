-- 0022 — Video posters: a still frame per video asset, for thumbnails.
--
-- AI motion graphics open on an empty background, so a <video> seeked by
-- guesswork paints a blank card; the worker's poster (the first headline fully
-- on screen) is the real thumbnail. One row per media_assets video that has one.
--
-- Its own table, not a media_assets column: drizzle selects every column it
-- knows about. Before this runs, reads fall back to seeking the video.
--
-- Apply via the Supabase SQL editor. Additive and idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.media_posters (
  asset_id uuid PRIMARY KEY,
  poster_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
