-- Free /try-image and /try-video generations. Anonymous visitors get a blurred
-- preview; the full file unlocks when they sign in (claimed_by).
CREATE TABLE IF NOT EXISTS "try_generations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL,
  "prompt" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "visitor" text NOT NULL,
  "ip_hash" text NOT NULL,
  "task_id" text,
  "original_key" text,
  "preview_url" text,
  "claimed_by" text,
  "media_asset_id" uuid,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "try_gen_created_idx" ON "try_generations" ("kind", "created_at");
CREATE INDEX IF NOT EXISTS "try_gen_visitor_idx" ON "try_generations" ("visitor");
CREATE INDEX IF NOT EXISTS "try_gen_ip_idx" ON "try_generations" ("ip_hash");
