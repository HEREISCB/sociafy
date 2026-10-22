-- 0023 — New users start on "Post automatically".
--
-- agent_settings.auto_publish_threshold: drafts scoring >= it are scheduled
-- on their own (lib/agent/publish.ts). Scores are 0-100 and 0 means unrated
-- (placeholder copy or an unparseable model reply) — publishOrHold never
-- auto-schedules those. So 1 = every rated draft posts at its slot, and
-- 101 stays "Ask me first". Supersedes 0006's 101 default.
--
-- Default only: existing rows keep their setting. Switching existing
-- review-mode users is scripts/auto-approve-everyone.mjs, run separately.
-- Apply via the Supabase SQL editor. Additive and idempotent: safe to re-run.

ALTER TABLE public.agent_settings
  ALTER COLUMN auto_publish_threshold SET DEFAULT 1;
