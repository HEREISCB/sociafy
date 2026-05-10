-- Sociafy initial schema. Paste into the Postgres SQL Editor (Supabase, Neon, etc.) or run via drizzle-kit push.
-- Idempotent: safe to re-run.
--
-- Auth is handled by Clerk — user_id columns store Clerk user IDs as text (e.g. "user_2abc...").
-- Storage is handled by Cloudflare R2 — media_assets stores R2 object keys + public URLs.
-- The DB has no FK to an auth table; security is enforced at the API layer (every route filters by user_id).

-- =====================================================
-- profiles
-- =====================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id            text PRIMARY KEY,            -- Clerk userId
  display_name  text,
  handle        text,
  avatar_url    text,
  email         text,
  onboarded_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- =====================================================
-- connected_accounts
-- =====================================================
CREATE TABLE IF NOT EXISTS public.connected_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             text NOT NULL,
  platform            text NOT NULL,
  platform_user_id    text NOT NULL,
  handle              text,
  display_name        text,
  avatar_url          text,
  access_token        text NOT NULL,
  refresh_token       text,
  token_expires_at    timestamptz,
  scope               text,
  meta                jsonb DEFAULT '{}'::jsonb,
  is_stub             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connected_accounts_user_idx ON public.connected_accounts (user_id);
CREATE INDEX IF NOT EXISTS connected_accounts_user_platform_idx ON public.connected_accounts (user_id, platform);

-- =====================================================
-- drafts
-- =====================================================
CREATE TABLE IF NOT EXISTS public.drafts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  text NOT NULL,
  title                    text,
  prompt                   text,
  body                     text NOT NULL DEFAULT '',
  variants                 jsonb DEFAULT '[]'::jsonb,
  selected_variant_label   text,
  media                    jsonb DEFAULT '[]'::jsonb,
  target_platforms         jsonb NOT NULL DEFAULT '[]'::jsonb,
  per_platform_text        jsonb DEFAULT '{}'::jsonb,
  preset                   text,
  status                   text NOT NULL DEFAULT 'draft',
  source                   text NOT NULL DEFAULT 'user',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS drafts_user_idx ON public.drafts (user_id);
CREATE INDEX IF NOT EXISTS drafts_status_idx ON public.drafts (status);

-- =====================================================
-- scheduled_posts
-- =====================================================
CREATE TABLE IF NOT EXISTS public.scheduled_posts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             text NOT NULL,
  draft_id            uuid NOT NULL REFERENCES public.drafts(id) ON DELETE CASCADE,
  account_id          uuid NOT NULL REFERENCES public.connected_accounts(id) ON DELETE CASCADE,
  platform            text NOT NULL,
  scheduled_at        timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  text                text NOT NULL,
  media               jsonb DEFAULT '[]'::jsonb,
  platform_post_id    text,
  platform_post_url   text,
  published_at        timestamptz,
  error               text,
  attempts            int NOT NULL DEFAULT 0,
  engagement          jsonb DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_user_idx ON public.scheduled_posts (user_id);
CREATE INDEX IF NOT EXISTS scheduled_status_due_idx ON public.scheduled_posts (status, scheduled_at);
CREATE INDEX IF NOT EXISTS scheduled_draft_idx ON public.scheduled_posts (draft_id);

-- =====================================================
-- agent_settings
-- =====================================================
CREATE TABLE IF NOT EXISTS public.agent_settings (
  user_id                  text PRIMARY KEY,
  enabled                  boolean NOT NULL DEFAULT false,
  instructions             text NOT NULL DEFAULT '',
  cadence_per_week         int NOT NULL DEFAULT 4,
  auto_publish_threshold   int NOT NULL DEFAULT 90,
  quiet_hours              jsonb DEFAULT '{"start":"22:00","end":"07:00"}'::jsonb,
  brand_safety_strict      boolean NOT NULL DEFAULT true,
  niches                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  voice_template           text DEFAULT 'me',
  trend_sources            jsonb DEFAULT '[]'::jsonb,
  last_run_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- =====================================================
-- activity_log
-- =====================================================
CREATE TABLE IF NOT EXISTS public.activity_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL,
  kind          text NOT NULL,
  title         text NOT NULL,
  body          text,
  meta          jsonb DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_user_created_idx ON public.activity_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_kind_idx ON public.activity_log (kind);

-- =====================================================
-- trends
-- =====================================================
CREATE TABLE IF NOT EXISTS public.trends (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            text NOT NULL,
  niche              text NOT NULL,
  title              text NOT NULL,
  summary            text,
  source             text,
  source_url         text,
  volume             int,
  delta              numeric,
  score              int NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'new',
  captured_at        timestamptz NOT NULL DEFAULT now(),
  used_in_draft_id   uuid REFERENCES public.drafts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS trends_user_status_idx ON public.trends (user_id, status);
CREATE INDEX IF NOT EXISTS trends_niche_idx ON public.trends (niche);

-- =====================================================
-- media_assets — Cloudflare R2 objects
-- =====================================================
CREATE TABLE IF NOT EXISTS public.media_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text NOT NULL,
  storage_key     text NOT NULL,
  public_url      text NOT NULL,
  mime_type       text NOT NULL,
  size_bytes      int,
  width           int,
  height          int,
  duration_s      numeric,
  label           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_user_idx ON public.media_assets (user_id);
