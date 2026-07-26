-- 0010 — Developer API keys for the public metered /api/v1 surface.
--
-- A developer is just a profiles row: the key maps to a Clerk user_id, so
-- credits, the ledger, refunds and R2 namespacing all work unchanged. No
-- orgs, no separate customer entity.
--
-- key_hash is SHA-256 of the plaintext key (full-entropy random, so there is
-- nothing to stretch against) and is UNIQUE so auth is one indexed lookup.
-- Apply via the Supabase SQL editor (db:push is unreliable for this project).
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.api_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          text NOT NULL,
  name             text NOT NULL DEFAULT '',
  prefix           text NOT NULL,
  key_hash         text NOT NULL,
  daily_credit_cap integer NOT NULL DEFAULT 2000,
  last_used_at     timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uniq ON public.api_keys (key_hash);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON public.api_keys (user_id);
