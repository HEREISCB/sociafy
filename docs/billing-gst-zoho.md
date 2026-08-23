# GST Invoicing via Zoho Books — One-time setup

Every captured Razorpay payment raises a GST invoice in Zoho Books, marks it
paid, and emails it to the customer. Nothing here is called on the checkout
path — invoicing happens in the webhook, after the money and the credits.

## The one pricing decision baked in

**Our prices are GST-inclusive.** ₹2,999 is what the card is charged *and* what
the invoice totals to; the 18% is backed out of it (₹2,541.53 + ₹457.47). The
alternative — adding 18% on top — means editing every price in
`lib/billing/pricing.ts`, every Razorpay Plan, and the pricing page, and your
₹2,999 plan starts charging ₹3,538.82. If you want exclusive pricing instead,
say so; it's a pricing change, not a code change to this integration.

Zoho does the CGST+SGST vs IGST split itself, from the customer's place of
supply against the org's own state. We never compute it.

---

## What I need from you

### 1. Zoho Books organisation
- **Region** → `ZOHO_REGION` (`in` for a zoho.in account — the default).
- **Organization ID** → `ZOHO_ORGANIZATION_ID`.
  Zoho Books → Settings → Organisation → Profile. It's the number in the URL too.
- Confirm the org's own **GSTIN and state** are filled in under
  Settings → Taxes → GST Settings. Zoho needs its own state to decide
  intra-state vs inter-state; the code assumes GNIX's registered state is
  **Uttar Pradesh** (see `HOME_STATE_ZOHO` in `lib/billing/zoho/invoice.ts`).
  If GNIX is registered elsewhere, tell me and I'll change that constant.

### 2. Self-client OAuth credentials
Go to [api-console.zoho.in](https://api-console.zoho.in) → **Add Client** →
**Self Client**.

- **Client ID** → `ZOHO_CLIENT_ID`
- **Client Secret** → `ZOHO_CLIENT_SECRET`
- Then the **Generate Code** tab:
  - Scope: `ZohoBooks.contacts.CREATE,ZohoBooks.contacts.UPDATE,ZohoBooks.contacts.READ,ZohoBooks.invoices.CREATE,ZohoBooks.invoices.UPDATE,ZohoBooks.invoices.READ,ZohoBooks.customerpayments.CREATE,ZohoBooks.settings.READ`
    (or just `ZohoBooks.fullaccess.all` if that's easier)
  - Time duration: 10 minutes. Scope description: anything.
  - Copy the `code`, then exchange it once for a refresh token:

    ```
    curl -X POST "https://accounts.zoho.in/oauth/v2/token" \
      -d "grant_type=authorization_code" \
      -d "client_id=<CLIENT_ID>" \
      -d "client_secret=<CLIENT_SECRET>" \
      -d "code=<CODE>"
    ```

  - **`refresh_token` from the response** → `ZOHO_REFRESH_TOKEN`.
    It does not expire. The access token is refreshed automatically.

### 3. The 18% GST tax
Zoho Books → Settings → Taxes → Tax Rates. Find (or create) the **18% GST**
rate. Its `tax_id` → `ZOHO_GST_TAX_ID`.

Get it with:
```
curl -H "Authorization: Zoho-oauthtoken <ACCESS_TOKEN>" \
  "https://www.zohoapis.in/books/v3/settings/taxes?organization_id=<ORG_ID>"
```

Without this the invoice is raised at ₹0 tax.

### 4. Deposit account
Zoho Books → Accountant → Chart of Accounts. Pick where Razorpay settlements
land (usually a bank account, or "Undeposited Funds"). Its `account_id` →
`ZOHO_DEPOSIT_ACCOUNT_ID`.

```
curl -H "Authorization: Zoho-oauthtoken <ACCESS_TOKEN>" \
  "https://www.zohoapis.in/books/v3/chartofaccounts?organization_id=<ORG_ID>"
```

Optional. If unset, invoices are raised and sent but left unpaid — you'd have
to reconcile by hand.

### 5. Confirm the SAC code
Default is **998314** (IT design & development services). If your CA wants a
different SAC for the SaaS subscription, set `ZOHO_SAC_CODE`.

---

## Env block

```
ZOHO_REGION=in
ZOHO_ORGANIZATION_ID=
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REFRESH_TOKEN=
ZOHO_GST_TAX_ID=
ZOHO_DEPOSIT_ACCOUNT_ID=
ZOHO_SAC_CODE=998314
```

Unset ZOHO_* vars are safe: `isStubMode.zoho()` short-circuits, payments and
credits work exactly as before, and each invoice is recorded as `failed` with
`zoho_not_configured` so the hourly retry raises it the moment you fill them in.

## SQL migration

Paste `drizzle/0011_gst_invoicing.sql` into the Supabase SQL Editor and run.
Idempotent, safe to re-run.

## Cron

`etc/cron.d/sociafy` gained an hourly `reissue-invoices` job that retries any
invoice Zoho rejected (up to 8 attempts). Re-run
`sudo bash scripts/install-cron.sh` after deploying, or the retry never fires.

---

## How it behaves

| Customer | GST treatment | Invoice |
|---|---|---|
| India, GSTIN on file | `business_gst` | B2B tax invoice, CGST+SGST or IGST by place of supply |
| India, no GSTIN | `consumer` | B2C tax invoice, tax still charged |
| Outside India | `overseas` | Export of services, zero-rated |

- Details are collected in onboarding's **Brand** step and editable on
  **/billing → Invoicing details**.
- The GSTIN field is checksum-validated (`lib/billing/gst.ts`), not just
  shape-matched — a transposed digit is rejected at entry rather than showing
  up on a filed invoice.
- Invoices are listed on /billing with a download link (Zoho's own share URL).
- Idempotency: `invoices(user_id, source)` is unique and `source` carries the
  Razorpay payment id, so a replayed webhook raises nothing.
- Only `subscription.charged` and `payment.captured` invoice —
  `subscription.activated` carries no payment.

## Verifying end-to-end

1. Razorpay Test Mode, buy a 1,000-credit top-up with a test card.
2. Watch the app logs for `[zoho.invoice]` — silence means it worked.
3. Zoho Books → Invoices: one paid invoice, correct GSTIN and tax split.
4. /billing → Invoices: the row is there with a working Download link.
