# Razorpay Billing Integration — Design

_Date: 2026-05-22 · Status: Draft, pending user review_

## 1. Context & goal

Sociafy currently bills via Stripe (USD only) using subscription Checkout
plus a webhook that mirrors state into `profiles` and writes idempotent
monthly credit grants into `credit_ledger`. Tiers: Starter $30, Pro $80,
Business $299.

The primary near-term customer is in India. **This spec adds Razorpay as
the active payment provider with INR pricing** while leaving the existing
Stripe wiring in place but unrouted (re-enabled in a future spec when we
wire Stripe to non-Indian users).

Tier definitions, credit amounts, the credit ledger, and per-action
pricing are **unchanged**. Only the payment-collection surface changes.

### 1.1 INR pricing (set in this spec)

| Tier      | USD (existing) | INR (new) | Credits / mo |
|-----------|---------------:|----------:|-------------:|
| Starter   | $30            | ₹2,999    | 2,000        |
| Pro       | $80            | ₹7,999    | 6,000        |
| Business  | $299           | ₹29,999   | 25,000       |
| Top-up    | $15 / 1k       | ₹1,499 / 1k | +1,000       |

GST: out of scope for this spec. Prices quoted are the total customer
pays. GST registration + invoicing will be a follow-up once we cross the
₹20 lakh threshold.

## 2. Scope

In scope:
- Razorpay Subscriptions integration via Standard Checkout (modal).
- Razorpay one-time orders for top-ups.
- Cancel-at-period-end from the billing page (Razorpay only).
- Upgrade (immediate, prorated diff via second modal) and downgrade
  (scheduled at period_end) for Razorpay subscriptions.
- IP-geo based currency detection on `/billing`. Indian visitors see the
  Razorpay flow; non-Indian visitors see disabled "USD billing — coming
  soon" buttons.
- A `BillingProvider` interface with one implementation (Razorpay) so a
  Stripe implementation can be added later without re-architecting.
- Shared post-payment helpers in `lib/billing/state.ts` that the Razorpay
  webhook (and future Stripe wiring) both call.

Out of scope:
- Re-routing or modifying the existing Stripe code path (left in place,
  not reachable from the UI).
- GST registration / invoice generation.
- Multi-currency Stripe (deferred — separate spec when we do it).
- Razorpay International (non-INR Razorpay).

## 3. Overview & data flow

```
GET /billing
  └─→ GET /api/billing
        ├─→ read profile
        ├─→ read x-vercel-ip-country (write-through to billing_country if null)
        └─→ return { tier, balance, currency, provider, isIndia, ... }

User clicks "Upgrade to Pro":
  POST /api/billing/checkout { tier: 'pro' }
    └─→ providerFor(profile)         // returns RazorpayProvider for IN users
    └─→ provider.startSubscription({ userId, tier: 'pro' })
        ├─→ ensure razorpay_customer_id (create via /customers if missing)
        ├─→ /subscriptions/create with plan_id=plan_pro
        └─→ returns CheckoutHandoff = { kind: 'razorpay_modal', ... }
    └─→ response → client opens Razorpay modal

User completes mandate authorization in modal:
  Razorpay webhook → POST /api/razorpay/webhook
    ├─→ verify HMAC-SHA256 signature
    ├─→ parse event (subscription.activated, subscription.charged, ...)
    └─→ lib/billing/state.ts helpers:
          - applySubscriptionState(userId, provider, normalizedStatus, periodEnd, tier)
          - applyMonthlyGrant(userId, tier, source)   // idempotent on source
```

Once an active subscription exists, `provider` and `currency` are locked
on the profile until cancellation completes (period_end passes).

## 4. Schema changes

Single migration `drizzle/0007_billing_providers.sql` (0006 is the
drafts-only default migration).

```sql
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS billing_country          text,          -- ISO 3166-1 alpha-2, e.g. 'IN', 'US'. Null = unknown.
  ADD COLUMN IF NOT EXISTS billing_currency         text,          -- 'INR' | 'USD'. Locked once a subscription is active.
  ADD COLUMN IF NOT EXISTS payment_provider         text,          -- 'stripe' | 'razorpay'. Locked once a subscription is active.
  ADD COLUMN IF NOT EXISTS razorpay_customer_id     text,
  ADD COLUMN IF NOT EXISTS razorpay_subscription_id text,
  ADD COLUMN IF NOT EXISTS pending_tier_change_to   text,          -- target Tier for a scheduled downgrade
  ADD COLUMN IF NOT EXISTS pending_tier_change_at   timestamptz;   -- when the downgrade takes effect (cycle end)

CREATE INDEX IF NOT EXISTS profiles_razorpay_customer_idx
  ON public.profiles (razorpay_customer_id);
CREATE INDEX IF NOT EXISTS profiles_razorpay_subscription_idx
  ON public.profiles (razorpay_subscription_id);
```

`drizzle/schema.ts` gets the corresponding column additions.

**`credit_ledger`** is unchanged. The existing `kind` enum already
includes `'monthly_grant'` and `'topup'` — we reuse both directly. No
schema enum change needed. Idempotency continues to rely on `meta.source`
uniqueness within a user's recent ledger rows.

**`subscriptionStatus` normalization** — Razorpay's vocabulary maps to
the existing four-value space the UI already reads:

| Razorpay state    | Normalized       |
|-------------------|------------------|
| created           | `incomplete`     |
| authenticated     | `incomplete`     |
| active            | `active`         |
| pending           | `past_due`       |
| halted            | `past_due`       |
| paused            | `past_due`       |
| cancelled         | `canceled`       |
| completed         | `canceled`       |
| expired           | `canceled`       |

The mapping lives in `lib/billing/providers/razorpay/status.ts`.

## 5. Pricing module

New file `lib/billing/pricing.ts`:

```ts
export type Currency = 'USD' | 'INR';

export const TIER_PRICING: Record<Currency, Record<Tier, {
  priceMonthly: string;        // display: '$30' / '₹2,999'
  amountMinor: number;         // 3000 (cents) / 299900 (paise)
}>> = {
  USD: {
    starter:  { priceMonthly: '$30',  amountMinor: 3000   },
    pro:      { priceMonthly: '$80',  amountMinor: 8000   },
    business: { priceMonthly: '$299', amountMinor: 29900  },
  },
  INR: {
    starter:  { priceMonthly: '₹2,999',  amountMinor: 299900   },
    pro:      { priceMonthly: '₹7,999',  amountMinor: 799900   },
    business: { priceMonthly: '₹29,999', amountMinor: 2999900  },
  },
};

export const TOPUP_PRICING: Record<Currency, { amountMinor: number; credits: number; display: string }> = {
  USD: { amountMinor: 1500,   credits: 1000, display: '$15 / 1,000 credits'   },
  INR: { amountMinor: 149900, credits: 1000, display: '₹1,499 / 1,000 credits' },
};

export function formatPrice(currency: Currency, tier: Tier): string {
  return TIER_PRICING[currency][tier].priceMonthly;
}
```

`lib/stripe.ts`'s `TIER_META` re-exports `priceMonthly` from this module
for backwards compatibility (the legacy Stripe code keeps compiling but
nothing reads it through `TIER_META.priceMonthly` going forward — UI
reads `formatPrice(currency, tier)` directly).

## 6. Provider abstraction

`lib/billing/provider.ts`:

```ts
import type { Tier } from '../db/schema';
import type { Currency } from './pricing';

export type CheckoutHandoff =
  | { kind: 'redirect'; url: string }                              // Stripe (future)
  | {
      kind: 'razorpay_modal';
      keyId: string;
      subscriptionId?: string;   // present for subscription checkouts
      orderId?: string;          // present for top-ups + upgrade-diff payments
      amountMinor: number;
      currency: 'INR';
      description: string;
      prefill: { email?: string; name?: string };
      notes: Record<string, string>;  // echoed back via webhook for routing
    };

export type TierChangeResult =
  | { kind: 'immediate'; effectiveAt: Date; handoff?: CheckoutHandoff } // upgrade
  | { kind: 'scheduled'; effectiveAt: Date };                            // downgrade

export interface BillingProvider {
  readonly name: 'stripe' | 'razorpay';
  readonly currency: Currency;

  startSubscription(args: { userId: string; tier: Tier }): Promise<CheckoutHandoff>;
  startTopUp(args: { userId: string; credits: number }): Promise<CheckoutHandoff>;
  cancelSubscription(args: { userId: string }): Promise<void>;
  changeTier(args: { userId: string; toTier: Tier }): Promise<TierChangeResult>;
}
```

`lib/billing/router.ts`:

```ts
export function providerFor(profile: Profile): BillingProvider | null {
  // Locked once we've started a subscription. Otherwise derive from currency.
  const lockedTo = profile.paymentProvider;
  if (lockedTo === 'razorpay') return razorpayProvider();
  if (lockedTo === 'stripe')   return null;  // Stripe not wired yet → caller surfaces "coming soon"

  const currency = profile.billingCurrency
    ?? (profile.billingCountry === 'IN' ? 'INR' : 'USD');
  return currency === 'INR' ? razorpayProvider() : null;
}
```

Returning `null` for the Stripe path is intentional: the route layer
turns this into a `503 billing_coming_soon` response, the UI surfaces
the disabled "USD billing — coming soon" CTA.

### 6.1 Files added

```
lib/billing/
├── pricing.ts                         // §5
├── provider.ts                        // interface (§6)
├── router.ts                          // providerFor (§6)
├── state.ts                           // shared helpers (§7)
└── providers/
    └── razorpay/
        ├── index.ts                   // RazorpayProvider implementation
        ├── client.ts                  // Razorpay SDK singleton
        ├── status.ts                  // status normalization (§4)
        ├── customer.ts                // ensureRazorpayCustomer(userId)
        └── proration.ts               // upgrade diff math (§8)
```

## 7. Shared post-payment state helpers

DB side-effects that previously lived inline in the Stripe webhook get
split into two reusable primitives. The Stripe webhook is refactored to
call them (no behavior change); the Razorpay webhook calls them too.

**`lib/credits/ledger.ts`** — add `grantIdempotent` alongside the
existing `grant`, `ensureSignupBonus`, etc. This is a credit-ledger
concern, so it lives with the other ledger primitives:

```ts
/** Insert a grant only if no prior row carries the same meta.source.
 *  Idempotent over webhook replays. Returns true if a new row was written. */
export async function grantIdempotent(args: {
  userId: string;
  kind: Extract<CreditLedgerKind, 'monthly_grant' | 'topup'>;
  credits: number;
  source: string;                       // e.g. 'rzp_sub:sub_xxx:payment_yyy'
  meta?: Record<string, unknown>;
}): Promise<boolean>;
```

It generalizes the existing inline `grantIfNew` helper from the Stripe
webhook. The 50-row recent-scan idempotency check is preserved as the
primary mechanism; a follow-up could promote `source` to a unique
constraint, but that's not in scope for this spec.

**`lib/billing/state.ts`** — billing-provider-agnostic profile mirror:

```ts
export async function applySubscriptionState(args: {
  userId: string;
  provider: 'stripe' | 'razorpay';
  status: NormalizedStatus;             // 'active' | 'past_due' | 'canceled' | 'incomplete'
  tier: Tier | null;                    // null = don't touch tier (status-only update)
  periodEnd: Date | null;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
}): Promise<void>;
```

This writes through to the provider-specific columns
(`stripe_customer_id` / `razorpay_customer_id`, etc.) based on
`provider`, plus the shared `subscription_status`,
`subscription_current_period_end`, and `tier` columns.

## 8. Razorpay tier-change semantics (the hard part)

### 8.1 Uniform user-visible rule

- **Upgrade**: takes effect immediately. User pays the prorated diff in
  a second Razorpay modal. New tier's full credit allocation grants now
  (with the delta credited — see §8.4).
- **Downgrade**: takes effect at `period_end`. No refund. UI shows
  "Downgrades to Pro on May 28."

### 8.2 Razorpay upgrade flow

Razorpay does not support plan changes on an active subscription, so we
implement upgrade as cancel-and-restart with a prorated diff payment:

1. Compute prorated diff:
   `(newAmount − oldAmount) × max(0, daysLeft) / cycleDays` (paise,
   integer floor). If the diff is ≤ 0 (extremely short cycle remaining),
   we skip the order and only do the plan swap.
2. Create a Razorpay Order for the diff (`POST /orders` with
   `notes: { kind: 'upgrade_diff', userId, fromTier, toTier, oldSubId }`).
3. Return `TierChangeResult.handoff` = `{ kind: 'razorpay_modal', orderId, ... }`
   to the client. The Razorpay Checkout JS modal opens for that order.
4. On `payment.captured` for an order with `notes.kind === 'upgrade_diff'`:
   - Cancel the old subscription: `subscriptions.cancel(oldSubId, false)`
     (immediate cancel, no period_end charge).
   - Create a new subscription on the target plan with `start_at = now`
     and the same `customer_id`.
   - `applySubscriptionState` mirrors the new sub.
   - `applyGrant` writes a `monthly_grant` for the **delta** between
     tiers (e.g. Starter→Pro mid-cycle grants 4,000 credits, not 6,000,
     so the upgraded user ends the cycle with the correct allocation).
5. The new subscription's `subscription.charged` webhooks at each
   renewal grant the full new-tier allocation normally.

Failure handling: if step 4's modal payment fails or is abandoned, the
old subscription is untouched. The order sits in Razorpay's system
unpaid and times out. No DB mutation happens. User can retry from the
billing page.

### 8.3 Razorpay downgrade flow

1. `POST /api/billing/change-tier { toTier: 'starter' }` while current
   tier is Pro.
2. Server validates `toTier` is strictly lower than current tier.
3. Server calls `subscriptions.cancel(currentSubId, true)` (cancel at
   cycle end) and writes `pending_tier_change_to = 'starter'` +
   `pending_tier_change_at = periodEnd` on the profile.
4. UI shows banner: "Switches to Starter on May 28. [Cancel switch]".
5. When `subscription.completed` webhook fires at cycle end:
   - Check if `pending_tier_change_to` is set for this user.
   - If yes: create a new subscription on the target plan with
     `start_at = now` and `customer_id = razorpay_customer_id`. Clear
     `pending_tier_change_*`. The new sub's `subscription.activated`
     webhook handles the first grant.
   - If no (pure cancel): mark canceled, leave credits intact, no new sub.
6. "Cancel switch" button: `POST /api/billing/change-tier { toTier: <currentTier> }`
   un-cancels by calling `subscriptions.update` to remove the pending
   cancellation, clears `pending_tier_change_*`. If Razorpay doesn't
   support un-cancel (it doesn't reliably), fallback is: clear
   `pending_tier_change_*` only, leave the cancellation in place — and
   surface this to the user clearly ("Subscription will still cancel on
   May 28. Re-subscribe before then to keep service uninterrupted.").
   **Decision for v1**: implement the simple version (clear pending
   only, surface the caveat). Razorpay un-cancel is not reliable enough
   to ship.

### 8.4 Delta-credit calculation on upgrade

Upgrading mid-cycle should give the user the **difference** between
their old tier's monthly grant and the new tier's monthly grant —
because they've already received the old tier's grant for this cycle.

```ts
function deltaCredits(fromTier: Tier, toTier: Tier): number {
  return TIER_CREDITS[toTier] - TIER_CREDITS[fromTier];
}
```

E.g. Starter (2,000 already granted) → Pro: grant 4,000 more, total
6,000 for the cycle. Top-ups remain top-ups.

## 9. Webhook

`/api/razorpay/webhook` — new route, runtime `nodejs`, reads raw body
via `req.text()`.

### 9.1 Signature verification

```ts
const sig = req.headers.get('x-razorpay-signature');
const body = await req.text();
const expected = crypto
  .createHmac('sha256', env.razorpay.webhookSecret)
  .update(body)
  .digest('hex');
if (!sig || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
  return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
}
```

### 9.2 Events handled

| Event                       | Action |
|-----------------------------|--------|
| `subscription.activated`    | First-purchase grant + state mirror. Idempotent on `source = 'rzp_sub:<sub_id>:activated'`. |
| `subscription.charged`      | Renewal grant. Source = `'rzp_sub:<sub_id>:<payment_id>'`. |
| `subscription.updated`      | Refresh period_end + status. No grant. |
| `subscription.cancelled`    | Mark canceled (keep credits to period_end). |
| `subscription.completed`    | Period ended naturally. If `pending_tier_change_to` set → create new sub on new plan. Otherwise mark canceled. |
| `subscription.halted`       | Mark `past_due`. UI prompts user to fix mandate. |
| `subscription.paused`       | Mark `past_due` (treated same as halted in our state machine). |
| `payment.captured` (order)  | If `notes.kind === 'topup'` → `topup`. If `notes.kind === 'upgrade_diff'` → run upgrade leg 2 (§8.2 step 4). |
| anything else               | 2xx no-op. |

The Stripe webhook continues to run with its existing handler, just
refactored to call `applySubscriptionState` / `applyGrant`.

## 10. Routes

| Route | Method | Behavior |
|---|---|---|
| `GET /api/billing` | GET | Existing route; extended to return `currency`, `provider`, `isIndia`, `canSwitchProvider`, `pendingTierChange`. Writes `billing_country` from `x-vercel-ip-country` if currently null. |
| `POST /api/billing/checkout` | POST | Refactored. Calls `providerFor(profile)`. If `null` → `503 billing_coming_soon`. Otherwise `provider.startSubscription({ tier })`. |
| `POST /api/billing/topup` (new) | POST | `provider.startTopUp({ credits })`. Body: `{ credits: number }` validated to multiple of 1000 between 1000 and 100000. |
| `POST /api/billing/cancel` (new) | POST | `provider.cancelSubscription()`. Returns the period_end so UI can show the banner. |
| `POST /api/billing/change-tier` (new) | POST | `provider.changeTier({ toTier })`. Body: `{ toTier: Tier }`. Response: `TierChangeResult`. |
| `POST /api/billing/preferences` (new) | POST | Sets `billing_currency` (and effectively `payment_provider`) override. Returns `409 subscription_active` if there's an active sub. Body: `{ currency: 'INR' \| 'USD' }`. (USD always returns `coming_soon` flag for now, but the preference is stored.) |
| `POST /api/razorpay/webhook` (new) | POST | §9. |

All routes use the existing `withUser` middleware and the existing
`parseBody` / `jsonError` helpers.

## 11. IP geolocation

- Read `req.headers.get('x-vercel-ip-country')` in `GET /api/billing`.
- Local-dev fallback: env `DEV_FORCE_COUNTRY=IN` (or `US`) wins over the
  missing header. Documented in `SETUP.md`.
- Write-through: if `profile.billing_country` is null at request time,
  set it from the detected value in the same query that reads the
  profile. Never overwrite.
- The toggle on `/billing` (when no active sub) is asymmetric:
  - **Indian visitors** see a single static banner ("Detected: India ·
    Pay in ₹ INR via Razorpay") plus a small "USD billing coming soon"
    note. No toggle — they only have the working option.
  - **Non-Indian visitors** see the disabled "USD billing (Stripe) —
    coming soon" CTA on tier cards, plus an opt-in link "Pay in ₹ INR
    via Razorpay instead" above the grid. Clicking it calls
    `POST /api/billing/preferences { currency: 'INR' }` which sets
    `billing_currency = 'INR'` and unlocks the Razorpay flow. This lets
    NRI / international users opt in if they're willing to be billed in
    INR.

The toggle disappears entirely once a subscription is active; UI shows
a static "Billing in ₹ INR via Razorpay · cancel to change" line.

## 12. UI changes

All on `app/billing/page.tsx`. Component layout already exists; we add:

1. **Currency / provider banner** above tier grid:
   - Active sub: static line "Billing in ₹ INR via Razorpay".
   - Indian visitor, no sub: "Detected: India · Pay in ₹ INR via Razorpay" with subtle USD-coming-soon note.
   - Non-Indian visitor, no sub: "USD billing via Stripe — coming soon. Pay in ₹ INR via Razorpay instead?" with an opt-in link.
2. **Tier grid** reads `formatPrice(currency, tier)` instead of `TIER_META[tier].priceMonthly`. The CTA logic:
   - Current tier → "Current plan" disabled.
   - Higher tier + currency='INR' → "Upgrade to Pro" enabled.
   - Lower tier + currency='INR' → "Downgrade to Starter" enabled.
   - Currency='USD' → "USD billing coming soon" disabled.
3. **Cancel button** on the current-plan card when sub is active. Confirmation dialog. Banner after: "Subscription ends May 28 — credits remain usable until then."
4. **Pending-downgrade banner** when `pending_tier_change_to` is set: "Switches to Starter on May 28. [Cancel switch]".
5. **Top-up button + modal**: button next to the credit balance. Modal: three packs (1k / 2k / 5k credits at ₹1,499 / ₹2,998 / ₹7,495). Click opens Razorpay modal.
6. **Razorpay modal launcher** — new client component `components/billing/razorpay-checkout.tsx`:
   - Loads `https://checkout.razorpay.com/v1/checkout.js` once per session (script tag injection, cached after first load).
   - Opens modal with handoff params. `handler` callback redirects to `/billing?checkout=success` (same return URL pattern as Stripe).
   - `modal.ondismiss` shows a non-toxic "Checkout canceled" toast.
7. **API client dispatch**: `apiPost('/api/billing/checkout', { tier })` returns `CheckoutHandoff`. Caller branches:
   ```ts
   if (handoff.kind === 'redirect') window.location.href = handoff.url;
   else openRazorpayModal(handoff);
   ```

The existing `setToast`, `useApi`, and shell components are reused.

## 13. Environment variables

`lib/env.ts` adds:

```ts
razorpay: {
  keyId:        required('RAZORPAY_KEY_ID'),
  keySecret:    required('RAZORPAY_KEY_SECRET'),
  webhookSecret:required('RAZORPAY_WEBHOOK_SECRET'),
  planStarter:  required('RAZORPAY_PLAN_STARTER'),
  planPro:      required('RAZORPAY_PLAN_PRO'),
  planBusiness: required('RAZORPAY_PLAN_BUSINESS'),
},
```

Public:
- `NEXT_PUBLIC_RAZORPAY_KEY_ID` — Razorpay's `key_id` is safe to expose
  client-side (parallel to Stripe's publishable key).

Local dev:
- `DEV_FORCE_COUNTRY=IN` — forces the geo header for local testing.

`isStubMode.razorpay()` parallels the existing `isStubMode.stripe()`.

Existing `env.stripe.*` block is left untouched. The required envs stay
required so the current Stripe wiring keeps compiling, but the route
layer never calls into it.

## 14. Razorpay dashboard setup (manual, one-time)

Documented in a new `docs/billing-setup-razorpay.md`:
1. Create Plans (Subscriptions → Plans):
   - "Sociafy Starter (INR)" — ₹2,999 monthly.
   - "Sociafy Pro (INR)" — ₹7,999 monthly.
   - "Sociafy Business (INR)" — ₹29,999 monthly.
2. Create webhook endpoint pointing at
   `https://<host>/api/razorpay/webhook` with these events selected:
   `subscription.activated`, `subscription.charged`, `subscription.updated`,
   `subscription.cancelled`, `subscription.completed`, `subscription.halted`,
   `subscription.paused`, `payment.captured`.
3. Copy plan IDs into the env vars above.
4. Copy the webhook secret into `RAZORPAY_WEBHOOK_SECRET`.
5. Generate API keys (Settings → API Keys); copy into
   `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `NEXT_PUBLIC_RAZORPAY_KEY_ID`.

Test mode keys are used locally; live mode keys for production.

## 15. Testing strategy

- **Unit tests**:
  - `lib/billing/pricing.ts`: currency formatting, top-up math.
  - `lib/billing/router.ts`: provider selection rules including the
    locked-after-subscription case and Stripe-returns-null case.
  - `lib/billing/state.ts`: `applyGrant` idempotency across replays.
  - `lib/billing/providers/razorpay/status.ts`: status mapping.
  - `lib/billing/providers/razorpay/proration.ts`: diff math edge cases
    (last day of cycle, future-dated start, leap-year cycles).
- **Integration tests** (Vitest + supertest against the Next.js handler):
  - `POST /api/billing/preferences` enforces active-sub lock (409).
  - `POST /api/billing/change-tier` rejects invalid transitions (e.g.
    Starter → Starter, downgrade to current tier).
  - `POST /api/razorpay/webhook` with crafted signed bodies for each
    event type → asserts DB state and ledger inserts. Replaying the
    same event a second time produces no extra ledger row.
- **Manual test matrix** (in spec, run before shipping):
  1. New Indian visitor → /billing shows INR pricing, Razorpay CTA.
  2. New non-Indian visitor → /billing shows USD coming soon, INR opt-in
     link visible.
  3. Indian user upgrades to Pro → modal → mandate → return → balance
     shows 6,000.
  4. Pro user upgrades to Business → diff modal → return → balance
     shows 6,000 + 19,000 delta = 25,000.
  5. Business user downgrades to Pro → banner shows pending change.
  6. At simulated period_end (via Razorpay test mode webhook replay) →
     new Pro sub created, credits grant.
  7. User cancels subscription → banner, credits stay, no renewal.
  8. Webhook replay (same `payment_id` twice) → only one ledger row.
  9. Top-up flow: 1,000 credits → modal → return → balance +1,000.
 10. Stripe webhook still parses and applies correctly (regression
     check on the shared helpers).

## 16. Migration / deploy order

1. Run the migration `drizzle/0007_billing_providers.sql` in Supabase
   SQL editor (project memory notes db:push is unreliable).
2. Set Razorpay env vars in Vercel project settings (test mode first).
3. Deploy the code with `isStubMode.razorpay()` returning `true` until
   env is populated — `/api/billing/checkout` returns a friendly 503
   until envs land.
4. Configure Razorpay webhook endpoint in dashboard, run a manual
   `subscription.activated` test event from dashboard → confirm
   signature verifies and DB state updates.
5. Run through the manual test matrix in test mode end-to-end.
6. Flip Razorpay keys to live mode.
7. Soft-launch: only the first paying Indian customer goes through.
8. Monitor logs for the first week; if any webhook errors,
   `applyGrant` will skip duplicates safely on replay.

## 17. Open questions (none blocking)

- **Razorpay un-cancel for "Cancel switch" downgrade reversal**: we
  ship the "clear pending only" simple version (§8.3). If we later
  discover users abuse this, we can implement true subscription
  un-cancellation as a follow-up.
- **GST**: deferred per user decision. Re-visit when revenue approaches
  the ₹20 lakh threshold or a customer asks for a tax invoice.
- **Webhook source uniqueness**: current 50-row scan in `grantIfNew` is
  inherited; promoting `meta.source` to a true unique index is a small
  follow-up that would tighten guarantees.
