-- Sociafy initial schema. Paste into the Supabase SQL Editor (or run via drizzle-kit push).
-- Idempotent: safe to re-run.

-- =====================================================
-- profiles
-- =====================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  text,
  handle        text,
  avatar_url    text,
  onboarded_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "self select" ON public.profiles;
CREATE POLICY "self select" ON public.profiles FOR SELECT USING (auth.uid() = id);
DROP POLICY IF EXISTS "self update" ON public.profiles;
CREATE POLICY "self update" ON public.profiles FOR UPDATE USING (auth.uid() = id);
DROP POLICY IF EXISTS "self insert" ON public.profiles;
CREATE POLICY "self insert" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Auto-create a profile when a new auth user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =====================================================
-- connected_accounts
-- =====================================================
CREATE TABLE IF NOT EXISTS public.connected_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
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
ALTER TABLE public.connected_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "self all" ON public.connected_accounts;
CREATE POLICY "self all" ON public.connected_accounts FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- =====================================================
-- drafts
-- =====================================================
CREATE TABLE IF NOT EXISTS public.drafts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
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
ALTER TABLE public.drafts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "self all" ON public.drafts;
CREATE POLICY "self all" ON public.drafts FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- =====================================================
-- scheduled_posts
-- =====================================================
CREATE TABLE IF NOT EXISTS public.scheduled_posts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
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
ALTER TABLE public.scheduled_posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "self all" ON public.scheduled_posts;
CREATE POLICY "self all" ON public.scheduled_posts FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- =====================================================
-- agent_settings
-- =====================================================
CREATE TABLE IF NOT EXISTS public.agent_settings (
  user_id                  uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
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
ALTER TABLE public.agent_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "self all" ON public.agent_settings;
CREATE POLICY "self all" ON public.agent_settings FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- =====================================================
-- activity_log
-- =====================================================
CREATE TABLE IF NOT EXISTS public.activity_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  title         text NOT NULL,
  body          text,
  meta          jsonb DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_user_created_idx ON public.activity_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_kind_idx ON public.activity_log (kind);
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "self select" ON public.activity_log;
CREATE POLICY "self select" ON public.activity_log FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "self insert" ON public.activity_log;
CREATE POLICY "self insert" ON public.activity_log FOR INSERT WITH CHECK (auth.uid() = user_id);

-- =====================================================
-- trends
-- =====================================================
CREATE TABLE IF NOT EXISTS public.trends (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
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
ALTER TABLE public.trends ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "self all" ON public.trends;
CREATE POLICY "self all" ON public.trends FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- =====================================================
-- media_assets
-- =====================================================
CREATE TABLE IF NOT EXISTS public.media_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_path    text NOT NULL,
  public_url      text NOT NULL,
  mime_type       text NOT NULL,
  size_bytes      int,
  width           int,
  height          int,
  duration_s      numeric,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_user_idx ON public.media_assets (user_id);
ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "self all" ON public.media_assets;
CREATE POLICY "self all" ON public.media_assets FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- A storage bucket for media uploads (run separately if your bucket name differs)
-- INSERT INTO storage.buckets (id, name, public) VALUES ('media', 'media', true) ON CONFLICT DO NOTHING;
