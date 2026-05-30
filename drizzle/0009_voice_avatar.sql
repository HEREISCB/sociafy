-- Voice & Avatar Studio: cloned-voice profiles + generic Modal job table.
-- Apply via the Supabase SQL editor (db:push is unreliable for this project).

CREATE TABLE IF NOT EXISTS "voices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'preparing' NOT NULL,
  "ref_storage_key" text NOT NULL,
  "ref_public_url" text NOT NULL,
  "ref_duration_s" numeric,
  "transcript" text,
  "language" text,
  "consent_version" text NOT NULL,
  "consent_signature" text NOT NULL,
  "consent_accepted_at" timestamptz NOT NULL,
  "error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "voices_user_idx" ON "voices" ("user_id");

CREATE TABLE IF NOT EXISTS "gen_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "kind" text NOT NULL,
  "provider" text NOT NULL,
  "provider_call_id" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "input_json" jsonb,
  "media_asset_id" uuid,
  "error" text,
  "credit_ledger_id" uuid,
  "credits_charged" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "gen_jobs_user_idx" ON "gen_jobs" ("user_id");
CREATE INDEX IF NOT EXISTS "gen_jobs_call_idx" ON "gen_jobs" ("provider_call_id");
