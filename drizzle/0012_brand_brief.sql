-- 0012 — brand brief on agent_settings.
--
-- Why: `website` was collected at onboarding but never fetched — the model only
-- ever saw the line "Website: https://…". brand_brief holds a short LLM summary
-- of what the site actually says (what they sell, to whom, offers, tone), built
-- on settings save by lib/ai/brand-brief.ts and injected into every brand block.
-- brand_brief_source is the URL the brief was built from, so a changed website
-- reads as a stale brief and triggers a rebuild.
--
-- Both nullable — existing users keep working and get a brief the next time
-- they save their brand settings.
--
-- Apply via the Supabase SQL editor (db:push is unreliable for this project).
-- Idempotent: safe to re-run.

ALTER TABLE public.agent_settings
  ADD COLUMN IF NOT EXISTS brand_brief        text,
  ADD COLUMN IF NOT EXISTS brand_brief_source text;
