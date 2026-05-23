-- Adds the brand-profile fields to agent_settings.
-- Paste into Supabase SQL Editor (Database → SQL Editor → New query) and run.
-- Idempotent: safe to re-run.
--
-- Why: every AI call (image gen rewriter, video gen rewriter, caption
-- variants) should be enriched with "who is this user" context, not just
-- the loose prompt the user types in compose. Previously this context
-- only flowed into text compose (via `instructions` + `voiceTemplate`);
-- image and video rewrites were blind to the brand. These three columns
-- let users define the brand once and have it propagate everywhere.
--
-- Fields are all nullable — existing users continue to work, AI just
-- gets less context until they fill these in.

ALTER TABLE public.agent_settings
  ADD COLUMN IF NOT EXISTS company_name text,
  ADD COLUMN IF NOT EXISTS brand_bio    text,
  ADD COLUMN IF NOT EXISTS website      text;
