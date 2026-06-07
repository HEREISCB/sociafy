-- 0008 — Token refresh health + credit-grant idempotency hardening.
--
-- (1) connected_accounts: track refresh outcomes so the Connections page can
--     show "Reconnect needed" without waiting for a publish to fail.
-- (2) activity_log: register the platform_refresh_failed kind (text column,
--     enforced in TS) — no DB change beyond documenting it.
-- (3) credit_ledger: add a partial unique index keyed on meta->>'source'
--     so retried webhook deliveries cannot double-credit even if the in-app
--     scan window misses an older event.
--
-- Idempotent: safe to re-run.

ALTER TABLE public.connected_accounts
  ADD COLUMN IF NOT EXISTS last_refresh_at        timestamptz,
  ADD COLUMN IF NOT EXISTS last_refresh_error     text,
  ADD COLUMN IF NOT EXISTS last_refresh_error_at  timestamptz;

CREATE INDEX IF NOT EXISTS connected_accounts_refresh_error_idx
  ON public.connected_accounts (user_id)
  WHERE last_refresh_error IS NOT NULL;

-- Partial unique on (user_id, kind, meta->>'source'). Only enforced for rows
-- where source is present, so charges/refunds (which have no source) are
-- unaffected. This is the durable backstop for grantIdempotent's in-app
-- de-dupe scan.
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_user_kind_source_uniq
  ON public.credit_ledger (user_id, kind, ((meta->>'source')))
  WHERE meta ? 'source';
