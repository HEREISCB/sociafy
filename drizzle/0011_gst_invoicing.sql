-- 0011 — GST billing details on the profile + issued-invoice records.
--
-- Two halves:
--   1. profiles gains the fields a GST invoice legally needs: registered legal
--      name, GSTIN, PAN, billing address, and the place of supply (the 2-digit
--      GST state code) that decides CGST+SGST vs IGST.
--   2. `invoices` records every invoice we asked Zoho Books to raise. It is
--      written BEFORE the Zoho call — the UNIQUE (user_id, source) index is
--      what makes a replayed Razorpay webhook a no-op instead of a second
--      invoice for the same payment. A Zoho outage leaves status='failed' and
--      the hourly reissue sweep picks it up.
--
-- Apply via the Supabase SQL editor (db:push is unreliable for this project).
-- Idempotent: safe to re-run.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS legal_name       text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS gstin            text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS pan              text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS billing_address  jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS place_of_supply  text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS zoho_contact_id  text;

CREATE TABLE IF NOT EXISTS public.invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             text NOT NULL,
  -- 'subscription' | 'topup' | 'upgrade'
  kind                text NOT NULL,
  -- Idempotency key. Carries the Razorpay payment id, same convention as
  -- credit_ledger.meta.source.
  source              text NOT NULL,
  provider_payment_id text,
  currency            text NOT NULL DEFAULT 'INR',
  -- Minor units (paise). gross = taxable + tax, always, because our prices are
  -- tax-INCLUSIVE: gross is exactly what the card was charged.
  gross_minor         integer NOT NULL,
  taxable_minor       integer NOT NULL,
  tax_minor           integer NOT NULL,
  tax_rate_pct        integer NOT NULL DEFAULT 18,
  -- 'pending' | 'issued' | 'failed'
  status              text NOT NULL DEFAULT 'pending',
  zoho_invoice_id     text,
  zoho_invoice_number text,
  zoho_invoice_url    text,
  attempts            integer NOT NULL DEFAULT 0,
  error               text,
  meta                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_source_uniq ON public.invoices (user_id, source);
CREATE INDEX IF NOT EXISTS invoices_user_created_idx ON public.invoices (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_status_idx ON public.invoices (status);
