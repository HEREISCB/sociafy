-- Trend & Competitor Intelligence: Apify-backed social scraping, snapshots, competitor tracking, LinkedIn growth, LLM cache.
-- Apply via the Supabase SQL editor (db:push is unreliable for this project).

CREATE TABLE IF NOT EXISTS "api_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"meter" text NOT NULL,
	"amount" integer DEFAULT 1 NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "ai_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "trend_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"label" text,
	"source" text DEFAULT 'seed' NOT NULL,
	"platform" text DEFAULT 'instagram' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"post_count" integer DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "trend_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"hashtag_queried" text NOT NULL,
	"post_url" text NOT NULL,
	"likes" integer DEFAULT 0,
	"comments" integer DEFAULT 0,
	"views" integer DEFAULT 0,
	"caption" text,
	"post_hashtags" jsonb DEFAULT '[]'::jsonb,
	"owner" text,
	"owner_followers" integer DEFAULT 0,
	"type" text,
	"is_reel" boolean DEFAULT false,
	"audio_title" text,
	"audio_artist" text,
	"engagement_rate" double precision DEFAULT 0,
	"fetched_at" timestamp with time zone
);
CREATE TABLE IF NOT EXISTS "trend_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"tracked_hashtags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"niche" text,
	"company_description" text,
	"self_handle" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"username" text NOT NULL,
	"followers" integer DEFAULT 0,
	"following" integer DEFAULT 0,
	"bio" text,
	"location" text,
	"avg_likes" integer DEFAULT 0,
	"avg_comments" integer DEFAULT 0,
	"engagement_rate" double precision DEFAULT 0,
	"bot_score" integer DEFAULT 0,
	"bot_label" text,
	"bot_explanation" text,
	"last_analyzed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "creator_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"url" text,
	"type" text,
	"is_reel" boolean DEFAULT false,
	"likes" integer DEFAULT 0,
	"comments" integer DEFAULT 0,
	"score" integer DEFAULT 0,
	"caption" text,
	"thumbnail" text,
	"posted_at" timestamp with time zone
);
CREATE TABLE IF NOT EXISTS "watchlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"username" text NOT NULL,
	"note" text,
	"followers_at_add" integer DEFAULT 0,
	"engagement_rate" double precision DEFAULT 0,
	"bot_score" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "competitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"platform" text DEFAULT 'instagram' NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"followers" integer DEFAULT 0,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "competitor_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competitor_id" uuid NOT NULL,
	"caption" text,
	"likes" integer DEFAULT 0,
	"comments" integer DEFAULT 0,
	"views" integer DEFAULT 0,
	"shares" integer DEFAULT 0,
	"hashtags" jsonb DEFAULT '[]'::jsonb,
	"theme" text,
	"type" text,
	"post_url" text,
	"audio_title" text,
	"posted_at" timestamp with time zone
);
CREATE TABLE IF NOT EXISTS "competitor_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competitor_id" uuid NOT NULL,
	"date" date NOT NULL,
	"followers" integer DEFAULT 0,
	"posts_count" integer DEFAULT 0,
	"stories_count" integer DEFAULT 0,
	"avg_engagement_rate" double precision DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "linkedin_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"slug" text NOT NULL,
	"url" text NOT NULL,
	"name" text,
	"industry" text,
	"website" text,
	"headquarters" text,
	"founded_year" integer,
	"description" text,
	"specialities" jsonb DEFAULT '[]'::jsonb,
	"logo_url" text,
	"followers" integer DEFAULT 0,
	"employees" integer DEFAULT 0,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "linkedin_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"date" date NOT NULL,
	"followers" integer DEFAULT 0,
	"employees" integer DEFAULT 0
);

DO $$ BEGIN
  ALTER TABLE "competitor_metrics" ADD CONSTRAINT "competitor_metrics_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "competitor_posts" ADD CONSTRAINT "competitor_posts_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "creator_posts" ADD CONSTRAINT "creator_posts_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "linkedin_metrics" ADD CONSTRAINT "linkedin_metrics_company_id_linkedin_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."linkedin_companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "trend_posts" ADD CONSTRAINT "trend_posts_snapshot_id_trend_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."trend_snapshots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;


CREATE INDEX IF NOT EXISTS "api_usage_user_meter_created_idx" ON "api_usage" ("user_id","meter","created_at");
CREATE INDEX IF NOT EXISTS "trend_snapshots_user_fetched_idx" ON "trend_snapshots" ("user_id","fetched_at");
CREATE INDEX IF NOT EXISTS "trend_snapshots_user_platform_idx" ON "trend_snapshots" ("user_id","platform");
CREATE INDEX IF NOT EXISTS "trend_posts_snapshot_idx" ON "trend_posts" ("snapshot_id");
CREATE UNIQUE INDEX IF NOT EXISTS "creators_user_username_idx" ON "creators" ("user_id","username");
CREATE INDEX IF NOT EXISTS "creator_posts_creator_idx" ON "creator_posts" ("creator_id");
CREATE UNIQUE INDEX IF NOT EXISTS "watchlist_user_username_idx" ON "watchlist" ("user_id","username");
CREATE UNIQUE INDEX IF NOT EXISTS "competitors_user_platform_handle_idx" ON "competitors" ("user_id","platform","handle");
CREATE INDEX IF NOT EXISTS "competitor_posts_competitor_idx" ON "competitor_posts" ("competitor_id");
CREATE UNIQUE INDEX IF NOT EXISTS "competitor_metrics_competitor_date_idx" ON "competitor_metrics" ("competitor_id","date");
CREATE UNIQUE INDEX IF NOT EXISTS "linkedin_companies_user_slug_idx" ON "linkedin_companies" ("user_id","slug");
CREATE UNIQUE INDEX IF NOT EXISTS "linkedin_metrics_company_date_idx" ON "linkedin_metrics" ("company_id","date");
