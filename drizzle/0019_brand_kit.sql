-- 0019 — Brand kit: everything about a user's brand, item by item, each optional.
--
-- brand_kits.kit   jsonb, shape = BrandKit in lib/brand/kit.ts (validated by
--                  brandKitSchema in lib/validation.ts). Asset references are
--                  media_assets ids + their public URLs, re-checked for
--                  ownership on every write.
--
-- Its own table rather than an agent_settings column: drizzle selects every
-- column it knows about, so a new agent_settings column would break each
-- `select().from(agentSettings)` (autopilot cron, settings, Home) until this
-- runs. A separate table keeps a late migration from taking autopilot down —
-- and the kit (logos, fonts, screenshots) is not autopilot configuration.
-- Brand name / bio / website / style guide stay on agent_settings, where the
-- brand-brief builder and every prompt already read them.
--
-- Apply via the Supabase SQL editor. Additive and idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.brand_kits (
  user_id text PRIMARY KEY,
  kit jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
