-- 0017 — One connected account per (user, platform); disconnect keeps history.
--
-- (1) connected_accounts had only a NON-unique (user_id, platform) index, so a
--     double-submitted OAuth callback could create two rows for one platform.
--     Dedupe (keep the most recently updated row, repoint scheduled_posts at
--     it), then replace the index with a UNIQUE one.
-- (2) scheduled_posts.account_id was ON DELETE CASCADE: disconnecting an
--     account deleted every post ever published through it. Make it nullable
--     and ON DELETE SET NULL. The disconnect route cancels pending posts first.
--
-- Idempotent: safe to re-run.

BEGIN;

CREATE TEMP TABLE _ca_dupes ON COMMIT DROP AS
SELECT id, keep_id FROM (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY user_id, platform
           ORDER BY updated_at DESC, created_at DESC, id DESC
         ) AS keep_id
  FROM public.connected_accounts
) ranked
WHERE id <> keep_id;

UPDATE public.scheduled_posts sp
SET account_id = d.keep_id
FROM _ca_dupes d
WHERE sp.account_id = d.id;

DELETE FROM public.connected_accounts ca
USING _ca_dupes d
WHERE ca.id = d.id;

DROP INDEX IF EXISTS public.connected_accounts_user_platform_idx;
CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_user_platform_uniq
  ON public.connected_accounts (user_id, platform);

-- 0000_init declared the FK inline (Postgres names it *_fkey); drizzle-kit push
-- would have named it *_fk. Drop whichever exists, re-add under drizzle's name.
ALTER TABLE public.scheduled_posts
  DROP CONSTRAINT IF EXISTS scheduled_posts_account_id_fkey,
  DROP CONSTRAINT IF EXISTS scheduled_posts_account_id_connected_accounts_id_fk;
ALTER TABLE public.scheduled_posts
  ALTER COLUMN account_id DROP NOT NULL,
  ADD CONSTRAINT scheduled_posts_account_id_connected_accounts_id_fk
    FOREIGN KEY (account_id) REFERENCES public.connected_accounts(id) ON DELETE SET NULL;

COMMIT;
