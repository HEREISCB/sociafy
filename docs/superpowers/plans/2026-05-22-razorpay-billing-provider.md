# Razorpay Billing Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Razorpay as the active payment provider for Indian users (INR subscriptions, top-ups, cancel, upgrade/downgrade), with the existing Stripe code left in place but unrouted until a future spec re-enables it.

**Architecture:** A `BillingProvider` interface with one Razorpay implementation, selected per-user by a `providerFor(profile)` router based on detected/stored country. Shared post-payment helpers (`grantIdempotent` in the ledger, `applySubscriptionState` in `lib/billing/state.ts`) are called by both the new Razorpay webhook and the refactored Stripe webhook so the DB-mutation logic lives in one place.

**Tech Stack:** Next.js 16 App Router · TypeScript · Drizzle ORM (Postgres via Supabase) · Razorpay Node SDK · Clerk auth · Vitest (new in this plan).

**Spec:** [2026-05-22-razorpay-billing-provider-design.md](../specs/2026-05-22-razorpay-billing-provider-design.md)

---

## File Map

| File | Responsibility | New / Modified |
|---|---|---|
| `package.json` | Add `razorpay` runtime dep + `vitest`, `@vitest/coverage-v8` dev deps + `test` script | Modified |
| `vitest.config.ts` | Vitest config (Node environment, alias for `@/`) | New |
| `lib/env.ts` | `env.razorpay` block + `isStubMode.razorpay()` | Modified |
| `drizzle/0007_billing_providers.sql` | 6 new columns on `profiles` | New |
| `lib/db/schema.ts` | Mirror the 6 new columns in Drizzle schema | Modified |
| `lib/billing/pricing.ts` | `Currency`, `TIER_PRICING`, `TOPUP_PRICING`, `formatPrice()` | New |
| `lib/billing/provider.ts` | `BillingProvider` interface + `CheckoutHandoff` / `TierChangeResult` types | New |
| `lib/billing/router.ts` | `providerFor(profile)` | New |
| `lib/billing/state.ts` | `applySubscriptionState()` | New |
| `lib/credits/ledger.ts` | Add `grantIdempotent()` | Modified |
| `lib/billing/providers/razorpay/client.ts` | Razorpay SDK singleton | New |
| `lib/billing/providers/razorpay/status.ts` | Status normalization map | New |
| `lib/billing/providers/razorpay/customer.ts` | `ensureRazorpayCustomer()` | New |
| `lib/billing/providers/razorpay/proration.ts` | Prorated diff math | New |
| `lib/billing/providers/razorpay/index.ts` | `RazorpayProvider` class | New |
| `app/api/razorpay/webhook/route.ts` | Webhook: verify sig, route events | New |
| `app/api/stripe/webhook/route.ts` | Refactor to call shared helpers | Modified |
| `app/api/billing/route.ts` | Extend response with `currency`, `provider`, `pendingTierChange`, etc.; write-through `billing_country` | Modified |
| `app/api/billing/checkout/route.ts` | Delegate to `providerFor(profile).startSubscription()` | Modified |
| `app/api/billing/topup/route.ts` | New route → `provider.startTopUp()` | New |
| `app/api/billing/cancel/route.ts` | New route → `provider.cancelSubscription()` | New |
| `app/api/billing/change-tier/route.ts` | New route → `provider.changeTier()` | New |
| `app/api/billing/preferences/route.ts` | New route → set `billing_currency` (locked when active sub) | New |
| `components/billing/razorpay-checkout.tsx` | Loads Razorpay JS, opens modal from `CheckoutHandoff` | New |
| `app/billing/page.tsx` | Currency banner, top-up modal, cancel button, change-tier CTAs, pending-downgrade banner, modal dispatch | Modified |
| `docs/billing-setup-razorpay.md` | Razorpay dashboard one-time setup steps | New |

Tests live next to source as `*.test.ts` (Vitest convention used here).

---

## Phase 0 — Foundations

### Task 1: Install dependencies + Vitest setup

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install razorpay + Vitest packages**

```bash
npm install razorpay
npm install -D vitest @vitest/coverage-v8
```

Expected: `package.json` shows `razorpay` in dependencies and `vitest`, `@vitest/coverage-v8` in devDependencies.

- [ ] **Step 2: Add the `test` script to `package.json`**

Edit `package.json` `scripts` block to add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Final `scripts` block:

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "eslint",
  "test": "vitest run",
  "test:watch": "vitest",
  "db:push": "drizzle-kit push",
  "db:studio": "drizzle-kit studio",
  "db:bootstrap": "node scripts/db-bootstrap.mjs"
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
```

- [ ] **Step 4: Verify Vitest runs (no tests yet → "no test files found" is success)**

```bash
npm test
```

Expected: exits cleanly. "No test files found" message is fine.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add razorpay sdk and vitest test framework"
```

---

### Task 2: Add Razorpay env vars + isStubMode

**Files:**
- Modify: `lib/env.ts`

- [ ] **Step 1: Add `env.razorpay` block to `lib/env.ts`**

Insert after the existing `stripe` block, inside the `export const env = { ... } as const;` object:

```ts
  razorpay: {
    keyId:         required('RAZORPAY_KEY_ID'),
    keySecret:     required('RAZORPAY_KEY_SECRET'),
    webhookSecret: required('RAZORPAY_WEBHOOK_SECRET'),
    planStarter:   required('RAZORPAY_PLAN_STARTER'),
    planPro:       required('RAZORPAY_PLAN_PRO'),
    planBusiness:  required('RAZORPAY_PLAN_BUSINESS'),
  },
```

- [ ] **Step 2: Add `isStubMode.razorpay` and `DEV_FORCE_COUNTRY` reader**

In the same file, extend the `isStubMode` object:

```ts
export const isStubMode = {
  clerk: () => !env.clerk.publishableKey || !env.clerk.secretKey,
  database: () => !env.database.url,
  ai: () => !process.env.OPENAI_API_KEY && !env.anthropic.apiKey,
  r2: () => !env.r2.accountId || !env.r2.bucket,
  stripe: () => !env.stripe.secretKey,
  razorpay: () => !env.razorpay.keyId || !env.razorpay.keySecret,
  platform: (p: 'x' | 'linkedin' | 'instagram' | 'facebook' | 'tiktok' | 'youtube'): boolean => {
    switch (p) {
      case 'x': return !env.platforms.x.clientId;
      case 'linkedin': return !env.platforms.linkedin.clientId;
      case 'instagram': return !env.platforms.instagram.appId;
      case 'facebook': return !env.platforms.meta.appId;
      case 'tiktok': return !env.platforms.tiktok.clientKey;
      case 'youtube': return !env.platforms.google.clientId;
    }
  },
};
```

Also add a small helper at the bottom of the file for the dev geo override:

```ts
/** Returns the country to use when the Vercel geo header is absent. Reads
 *  DEV_FORCE_COUNTRY (e.g. 'IN' / 'US'). Returns null if unset. */
export function devForcedCountry(): string | null {
  return process.env.DEV_FORCE_COUNTRY?.toUpperCase() ?? null;
}
```

- [ ] **Step 3: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/env.ts
git commit -m "feat(env): add razorpay env block and dev country override"
```

---

### Task 3: Schema migration + Drizzle schema update

**Files:**
- Create: `drizzle/0007_billing_providers.sql`
- Modify: `lib/db/schema.ts`

- [ ] **Step 1: Write the SQL migration**

Create `drizzle/0007_billing_providers.sql`:

```sql
-- Add Razorpay billing columns + currency/country detection + pending tier changes.
-- Mirrors the existing Stripe linkage pattern. Paste into Supabase SQL Editor.
-- Idempotent: safe to re-run.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS billing_country           text,
  ADD COLUMN IF NOT EXISTS billing_currency          text,
  ADD COLUMN IF NOT EXISTS payment_provider          text,
  ADD COLUMN IF NOT EXISTS razorpay_customer_id      text,
  ADD COLUMN IF NOT EXISTS razorpay_subscription_id  text,
  ADD COLUMN IF NOT EXISTS pending_tier_change_to    text,
  ADD COLUMN IF NOT EXISTS pending_tier_change_at    timestamptz;

CREATE INDEX IF NOT EXISTS profiles_razorpay_customer_idx
  ON public.profiles (razorpay_customer_id);
CREATE INDEX IF NOT EXISTS profiles_razorpay_subscription_idx
  ON public.profiles (razorpay_subscription_id);
```

- [ ] **Step 2: Mirror the columns in `lib/db/schema.ts`**

Inside the `profiles = pgTable('profiles', { ... })` block, add these fields immediately after the existing `subscriptionCurrentPeriodEnd` field:

```ts
  // ---- new in 0007: Razorpay + multi-provider billing ----
  billingCountry: text('billing_country'),                              // ISO 3166-1 alpha-2
  billingCurrency: text('billing_currency').$type<'INR' | 'USD'>(),     // locked once active sub
  paymentProvider: text('payment_provider').$type<'stripe' | 'razorpay'>(), // locked once active sub
  razorpayCustomerId: text('razorpay_customer_id'),
  razorpaySubscriptionId: text('razorpay_subscription_id'),
  pendingTierChangeTo: text('pending_tier_change_to').$type<Tier>(),
  pendingTierChangeAt: timestamp('pending_tier_change_at', { withTimezone: true }),
```

- [ ] **Step 3: Run the migration in Supabase SQL Editor**

Per the memory note, drizzle's `db:push` is unreliable on this project — paste `drizzle/0007_billing_providers.sql` into Supabase SQL Editor (Database → SQL Editor → New query) and run.

Expected: 7 `ALTER TABLE ... ADD COLUMN` + 2 `CREATE INDEX` statements succeed.

- [ ] **Step 4: Verify schema compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add drizzle/0007_billing_providers.sql lib/db/schema.ts
git commit -m "feat(schema): add billing-provider columns to profiles"
```

---

## Phase 1 — Pure-function primitives (TDD)

### Task 4: `lib/billing/pricing.ts`

**Files:**
- Create: `lib/billing/pricing.ts`
- Create: `lib/billing/pricing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/billing/pricing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TIER_PRICING, TOPUP_PRICING, formatPrice } from './pricing';

describe('TIER_PRICING', () => {
  it('has matching shape for both currencies', () => {
    expect(Object.keys(TIER_PRICING.USD)).toEqual(['starter', 'pro', 'business']);
    expect(Object.keys(TIER_PRICING.INR)).toEqual(['starter', 'pro', 'business']);
  });

  it('uses correct minor units for INR (paise)', () => {
    expect(TIER_PRICING.INR.starter.amountMinor).toBe(299900);
    expect(TIER_PRICING.INR.pro.amountMinor).toBe(799900);
    expect(TIER_PRICING.INR.business.amountMinor).toBe(2999900);
  });

  it('uses correct minor units for USD (cents)', () => {
    expect(TIER_PRICING.USD.starter.amountMinor).toBe(3000);
    expect(TIER_PRICING.USD.pro.amountMinor).toBe(8000);
    expect(TIER_PRICING.USD.business.amountMinor).toBe(29900);
  });
});

describe('TOPUP_PRICING', () => {
  it('is ₹1,499 / 1,000 credits for INR', () => {
    expect(TOPUP_PRICING.INR.amountMinor).toBe(149900);
    expect(TOPUP_PRICING.INR.credits).toBe(1000);
  });

  it('is $15 / 1,000 credits for USD', () => {
    expect(TOPUP_PRICING.USD.amountMinor).toBe(1500);
    expect(TOPUP_PRICING.USD.credits).toBe(1000);
  });
});

describe('formatPrice', () => {
  it('returns ₹-prefixed display string for INR', () => {
    expect(formatPrice('INR', 'starter')).toBe('₹2,999');
    expect(formatPrice('INR', 'pro')).toBe('₹7,999');
    expect(formatPrice('INR', 'business')).toBe('₹29,999');
  });

  it('returns $-prefixed display string for USD', () => {
    expect(formatPrice('USD', 'starter')).toBe('$30');
    expect(formatPrice('USD', 'pro')).toBe('$80');
    expect(formatPrice('USD', 'business')).toBe('$299');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- lib/billing/pricing.test.ts
```

Expected: FAIL with "Cannot find module './pricing'".

- [ ] **Step 3: Implement `lib/billing/pricing.ts`**

```ts
/**
 * Currency-aware tier pricing. The tier IDs and credit allocations live in
 * `db/schema.ts` (TIERS, TIER_CREDITS); this module owns the display copy
 * and on-the-wire minor-unit amounts per currency. UI reads `formatPrice`;
 * providers read `amountMinor`.
 */

import type { Tier } from '../db/schema';

export type Currency = 'INR' | 'USD';

export const TIER_PRICING: Record<Currency, Record<Tier, {
  priceMonthly: string;
  amountMinor: number;
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

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- lib/billing/pricing.test.ts
```

Expected: PASS (10 assertions).

- [ ] **Step 5: Commit**

```bash
git add lib/billing/pricing.ts lib/billing/pricing.test.ts
git commit -m "feat(billing): add currency-aware tier pricing module"
```

---

### Task 5: `lib/billing/providers/razorpay/status.ts`

**Files:**
- Create: `lib/billing/providers/razorpay/status.ts`
- Create: `lib/billing/providers/razorpay/status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { normalizeRazorpayStatus } from './status';

describe('normalizeRazorpayStatus', () => {
  it('maps active -> active', () => {
    expect(normalizeRazorpayStatus('active')).toBe('active');
  });

  it('maps halt/pause states to past_due', () => {
    expect(normalizeRazorpayStatus('halted')).toBe('past_due');
    expect(normalizeRazorpayStatus('paused')).toBe('past_due');
    expect(normalizeRazorpayStatus('pending')).toBe('past_due');
  });

  it('maps cancelled/completed/expired -> canceled', () => {
    expect(normalizeRazorpayStatus('cancelled')).toBe('canceled');
    expect(normalizeRazorpayStatus('completed')).toBe('canceled');
    expect(normalizeRazorpayStatus('expired')).toBe('canceled');
  });

  it('maps created/authenticated -> incomplete', () => {
    expect(normalizeRazorpayStatus('created')).toBe('incomplete');
    expect(normalizeRazorpayStatus('authenticated')).toBe('incomplete');
  });

  it('defaults unknown states to incomplete', () => {
    expect(normalizeRazorpayStatus('some_new_state' as never)).toBe('incomplete');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- lib/billing/providers/razorpay/status.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `status.ts`**

```ts
/**
 * Razorpay subscription state vocabulary → the four-value vocabulary the
 * rest of the app understands. Unknown future states default to
 * 'incomplete' so the UI prompts the user to investigate rather than
 * silently treating an unknown state as healthy.
 */

export type RazorpaySubscriptionStatus =
  | 'created'
  | 'authenticated'
  | 'active'
  | 'pending'
  | 'halted'
  | 'paused'
  | 'cancelled'
  | 'completed'
  | 'expired';

export type NormalizedStatus = 'active' | 'past_due' | 'canceled' | 'incomplete';

export function normalizeRazorpayStatus(s: RazorpaySubscriptionStatus): NormalizedStatus {
  switch (s) {
    case 'active':                                    return 'active';
    case 'pending':
    case 'halted':
    case 'paused':                                    return 'past_due';
    case 'cancelled':
    case 'completed':
    case 'expired':                                   return 'canceled';
    case 'created':
    case 'authenticated':                             return 'incomplete';
    default:                                          return 'incomplete';
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- lib/billing/providers/razorpay/status.test.ts
```

Expected: PASS (5 assertions).

- [ ] **Step 5: Commit**

```bash
git add lib/billing/providers/razorpay/status.ts lib/billing/providers/razorpay/status.test.ts
git commit -m "feat(razorpay): add subscription status normalization"
```

---

### Task 6: `lib/billing/providers/razorpay/proration.ts`

**Files:**
- Create: `lib/billing/providers/razorpay/proration.ts`
- Create: `lib/billing/providers/razorpay/proration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { proratedDiffMinor, deltaCredits } from './proration';

describe('proratedDiffMinor', () => {
  it('returns full upgrade diff at start of cycle (30 days remaining of 30)', () => {
    // Starter ₹2,999 → Pro ₹7,999, full month remaining
    const periodStart = new Date('2026-05-01T00:00:00Z');
    const periodEnd   = new Date('2026-05-31T00:00:00Z');
    const now         = new Date('2026-05-01T00:00:00Z');
    expect(proratedDiffMinor({
      oldAmountMinor: 299900,
      newAmountMinor: 799900,
      now, periodStart, periodEnd,
    })).toBe(500000); // 7999 - 2999 = 5000 INR = 500000 paise
  });

  it('returns half the diff at mid-cycle (15 days remaining of 30)', () => {
    const periodStart = new Date('2026-05-01T00:00:00Z');
    const periodEnd   = new Date('2026-05-31T00:00:00Z');
    const now         = new Date('2026-05-16T00:00:00Z'); // 15 days left
    const result = proratedDiffMinor({
      oldAmountMinor: 299900,
      newAmountMinor: 799900,
      now, periodStart, periodEnd,
    });
    // (500000 * 15) / 30 = 250000
    expect(result).toBe(250000);
  });

  it('returns 0 when periodEnd has already passed', () => {
    const now         = new Date('2026-06-01T00:00:00Z');
    const periodStart = new Date('2026-05-01T00:00:00Z');
    const periodEnd   = new Date('2026-05-31T00:00:00Z');
    expect(proratedDiffMinor({
      oldAmountMinor: 299900,
      newAmountMinor: 799900,
      now, periodStart, periodEnd,
    })).toBe(0);
  });

  it('returns 0 when downgrading (negative diff clamped)', () => {
    const periodStart = new Date('2026-05-01T00:00:00Z');
    const periodEnd   = new Date('2026-05-31T00:00:00Z');
    const now         = new Date('2026-05-01T00:00:00Z');
    expect(proratedDiffMinor({
      oldAmountMinor: 799900,
      newAmountMinor: 299900,
      now, periodStart, periodEnd,
    })).toBe(0);
  });

  it('floors to the nearest paise/cent', () => {
    // Diff = 500000, daysLeft = 7, cycleDays = 30
    // (500000 * 7) / 30 = 116666.666... → 116666
    const periodStart = new Date('2026-05-01T00:00:00Z');
    const periodEnd   = new Date('2026-05-31T00:00:00Z');
    const now         = new Date('2026-05-24T00:00:00Z'); // 7 days left
    expect(proratedDiffMinor({
      oldAmountMinor: 299900,
      newAmountMinor: 799900,
      now, periodStart, periodEnd,
    })).toBe(116666);
  });
});

describe('deltaCredits', () => {
  it('returns the credit gap between tiers', () => {
    expect(deltaCredits('starter', 'pro')).toBe(4000);    // 6000 - 2000
    expect(deltaCredits('pro', 'business')).toBe(19000);  // 25000 - 6000
    expect(deltaCredits('starter', 'business')).toBe(23000); // 25000 - 2000
  });

  it('returns 0 or negative for same-tier or downgrade (callers should not grant)', () => {
    expect(deltaCredits('pro', 'pro')).toBe(0);
    expect(deltaCredits('business', 'pro')).toBe(-19000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- lib/billing/providers/razorpay/proration.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `proration.ts`**

```ts
/**
 * Razorpay doesn't auto-prorate on plan changes, so we compute the
 * difference manually when a user upgrades mid-cycle.
 *
 * Algorithm: diff = (newAmount − oldAmount) × max(0, msRemaining) / cycleMs.
 * Result is floored to integer minor units (paise / cents). Negative or
 * zero results clamp to 0 — downgrades take effect at period_end and
 * don't carry a prorated charge.
 */

import type { Tier } from '../../../db/schema';
import { TIER_CREDITS } from '../../../db/schema';

export function proratedDiffMinor(args: {
  oldAmountMinor: number;
  newAmountMinor: number;
  now: Date;
  periodStart: Date;
  periodEnd: Date;
}): number {
  const diff = args.newAmountMinor - args.oldAmountMinor;
  if (diff <= 0) return 0;

  const msRemaining = args.periodEnd.getTime() - args.now.getTime();
  if (msRemaining <= 0) return 0;

  const cycleMs = args.periodEnd.getTime() - args.periodStart.getTime();
  if (cycleMs <= 0) return 0;

  return Math.floor((diff * msRemaining) / cycleMs);
}

/**
 * Credit delta to grant on an upgrade. User has already received the old
 * tier's monthly grant; we top up by the gap so the cycle's total matches
 * the new tier's allocation.
 */
export function deltaCredits(fromTier: Tier, toTier: Tier): number {
  return TIER_CREDITS[toTier] - TIER_CREDITS[fromTier];
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- lib/billing/providers/razorpay/proration.test.ts
```

Expected: PASS (7 assertions).

- [ ] **Step 5: Commit**

```bash
git add lib/billing/providers/razorpay/proration.ts lib/billing/providers/razorpay/proration.test.ts
git commit -m "feat(razorpay): add prorated upgrade diff math"
```

---

## Phase 2 — Shared state helpers (TDD with mocked db)

### Task 7: `grantIdempotent` in `lib/credits/ledger.ts`

**Files:**
- Modify: `lib/credits/ledger.ts`
- Create: `lib/credits/grantIdempotent.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/credits/grantIdempotent.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = { id: string; userId: string; kind: string; credits: number; meta: Record<string, unknown> };

// In-memory ledger that mimics enough of the Drizzle chain for our needs.
const rows: Row[] = [];

vi.mock('../db', () => {
  let nextId = 1;
  return {
    db: () => ({
      select: (cols: unknown) => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(rows.map((r) => ({ id: r.id, meta: r.meta }))),
          }),
        }),
      }),
      insert: () => ({
        values: (v: Omit<Row, 'id'>) => {
          const row: Row = { ...v, id: String(nextId++) };
          rows.push(row);
          return { returning: () => Promise.resolve([{ id: row.id }]) };
        },
      }),
    }),
  };
});

import { grantIdempotent } from './ledger';

describe('grantIdempotent', () => {
  beforeEach(() => { rows.length = 0; });

  it('inserts a row when source is new', async () => {
    const wrote = await grantIdempotent({
      userId: 'u1',
      kind: 'monthly_grant',
      credits: 6000,
      source: 'rzp_sub:sub_abc:pay_xyz',
      meta: { tier: 'pro' },
    });
    expect(wrote).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].credits).toBe(6000);
    expect(rows[0].meta).toMatchObject({ source: 'rzp_sub:sub_abc:pay_xyz', tier: 'pro' });
  });

  it('skips when a row with the same source already exists', async () => {
    rows.push({
      id: 'pre-existing',
      userId: 'u1',
      kind: 'monthly_grant',
      credits: 6000,
      meta: { source: 'rzp_sub:sub_abc:pay_xyz' },
    });

    const wrote = await grantIdempotent({
      userId: 'u1',
      kind: 'monthly_grant',
      credits: 6000,
      source: 'rzp_sub:sub_abc:pay_xyz',
    });

    expect(wrote).toBe(false);
    expect(rows).toHaveLength(1); // no new row
  });

  it('stores positive credits even if negative is passed', async () => {
    await grantIdempotent({
      userId: 'u1',
      kind: 'topup',
      credits: -1000,
      source: 'rzp_topup:pay_abc',
    });
    expect(rows[0].credits).toBe(1000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- lib/credits/grantIdempotent.test.ts
```

Expected: FAIL with "grantIdempotent is not a function" or import error.

- [ ] **Step 3: Add `grantIdempotent` to `lib/credits/ledger.ts`**

Append this export to `lib/credits/ledger.ts` (after the existing `grant` function):

```ts
/**
 * Idempotent grant keyed by `meta.source`. Used by both Stripe and
 * Razorpay webhooks so that retried events do not double-credit a user.
 *
 * Implementation note: we scan the user's recent monthly_grant /
 * topup rows and check for a matching source in TS rather than relying
 * on a JSONB unique index (cheaper to ship, fast enough at our scale).
 * A future migration can promote `meta.source` to a true unique
 * constraint.
 */
export async function grantIdempotent(args: {
  userId: string;
  kind: Extract<CreditLedgerKind, 'monthly_grant' | 'topup'>;
  credits: number;
  source: string;
  meta?: Record<string, unknown>;
}): Promise<boolean> {
  const recent = await db()
    .select({ id: creditLedger.id, meta: creditLedger.meta })
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, args.userId), eq(creditLedger.kind, args.kind)))
    .limit(50);

  const dup = recent.find(
    (row) => (row.meta as Record<string, unknown> | null)?.source === args.source,
  );
  if (dup) return false;

  await db()
    .insert(creditLedger)
    .values({
      userId: args.userId,
      kind: args.kind,
      action: null,
      credits: Math.abs(args.credits),
      meta: { source: args.source, ...(args.meta ?? {}) } as Record<string, unknown>,
    })
    .returning({ id: creditLedger.id });
  return true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- lib/credits/grantIdempotent.test.ts
```

Expected: PASS (3 assertions).

- [ ] **Step 5: Commit**

```bash
git add lib/credits/ledger.ts lib/credits/grantIdempotent.test.ts
git commit -m "feat(ledger): add grantIdempotent for webhook-safe credit grants"
```

---

### Task 8: `lib/billing/state.ts` `applySubscriptionState`

**Files:**
- Create: `lib/billing/state.ts`
- Create: `lib/billing/state.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Update = Record<string, unknown> & { __whereId?: string };
const updates: Update[] = [];

vi.mock('../db', () => {
  return {
    db: () => ({
      update: () => ({
        set: (vals: Record<string, unknown>) => ({
          where: (clause: { __whereId?: string }) => {
            updates.push({ ...vals, __whereId: clause?.__whereId });
            return Promise.resolve();
          },
        }),
      }),
    }),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, val: string) => ({ __whereId: val }),
}));

import { applySubscriptionState } from './state';

describe('applySubscriptionState', () => {
  beforeEach(() => { updates.length = 0; });

  it('writes Razorpay columns when provider=razorpay', async () => {
    await applySubscriptionState({
      userId: 'u1',
      provider: 'razorpay',
      status: 'active',
      tier: 'pro',
      periodEnd: new Date('2026-06-01T00:00:00Z'),
      providerCustomerId: 'cust_abc',
      providerSubscriptionId: 'sub_xyz',
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      tier: 'pro',
      subscriptionStatus: 'active',
      paymentProvider: 'razorpay',
      razorpayCustomerId: 'cust_abc',
      razorpaySubscriptionId: 'sub_xyz',
      __whereId: 'u1',
    });
    expect(updates[0].stripeCustomerId).toBeUndefined();
  });

  it('writes Stripe columns when provider=stripe', async () => {
    await applySubscriptionState({
      userId: 'u2',
      provider: 'stripe',
      status: 'active',
      tier: 'starter',
      periodEnd: null,
      providerCustomerId: 'cus_st',
      providerSubscriptionId: 'sub_st',
    });

    expect(updates[0]).toMatchObject({
      paymentProvider: 'stripe',
      stripeCustomerId: 'cus_st',
      stripeSubscriptionId: 'sub_st',
    });
    expect(updates[0].razorpayCustomerId).toBeUndefined();
  });

  it('omits tier when tier=null (status-only update)', async () => {
    await applySubscriptionState({
      userId: 'u3',
      provider: 'razorpay',
      status: 'past_due',
      tier: null,
      periodEnd: null,
    });

    expect(updates[0].tier).toBeUndefined();
    expect(updates[0].subscriptionStatus).toBe('past_due');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- lib/billing/state.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `lib/billing/state.ts`**

```ts
/**
 * Provider-agnostic profile state mirror. Called by both Stripe and
 * Razorpay webhooks after they parse provider-specific events into a
 * normalized shape. Routes the right columns based on `provider`.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { profiles, type Tier } from '../db/schema';
import type { NormalizedStatus } from './providers/razorpay/status';

export async function applySubscriptionState(args: {
  userId: string;
  provider: 'stripe' | 'razorpay';
  status: NormalizedStatus;
  tier: Tier | null;
  periodEnd: Date | null;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
}): Promise<void> {
  const update: Record<string, unknown> = {
    subscriptionStatus: args.status,
    subscriptionCurrentPeriodEnd: args.periodEnd,
    paymentProvider: args.provider,
    updatedAt: new Date(),
  };
  if (args.tier) update.tier = args.tier;

  if (args.provider === 'razorpay') {
    if (args.providerCustomerId)    update.razorpayCustomerId    = args.providerCustomerId;
    if (args.providerSubscriptionId) update.razorpaySubscriptionId = args.providerSubscriptionId;
  } else {
    if (args.providerCustomerId)    update.stripeCustomerId    = args.providerCustomerId;
    if (args.providerSubscriptionId) update.stripeSubscriptionId = args.providerSubscriptionId;
  }

  await db().update(profiles).set(update).where(eq(profiles.id, args.userId));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- lib/billing/state.test.ts
```

Expected: PASS (3 assertions).

- [ ] **Step 5: Commit**

```bash
git add lib/billing/state.ts lib/billing/state.test.ts
git commit -m "feat(billing): add applySubscriptionState shared helper"
```

---

## Phase 3 — Provider interface & router

### Task 9: `lib/billing/provider.ts` interface

**Files:**
- Create: `lib/billing/provider.ts`

- [ ] **Step 1: Write the interface and types**

```ts
/**
 * Payment-provider abstraction. One interface, two implementations
 * planned: Razorpay (this spec) and Stripe (future). Route handlers and
 * the billing UI talk to this interface; the router decides which
 * implementation a given user gets.
 */

import type { Tier } from '../db/schema';
import type { Currency } from './pricing';

export type CheckoutHandoff =
  | { kind: 'redirect'; url: string }                       // Stripe-shape (future)
  | {
      kind: 'razorpay_modal';
      keyId: string;
      subscriptionId?: string;    // present for subscription checkouts
      orderId?: string;           // present for top-ups + upgrade-diff payments
      amountMinor: number;
      currency: 'INR';
      description: string;
      prefill: { email?: string; name?: string };
      notes: Record<string, string>;
    };

export type TierChangeResult =
  | { kind: 'immediate'; effectiveAt: Date; handoff?: CheckoutHandoff }  // upgrade
  | { kind: 'scheduled'; effectiveAt: Date };                             // downgrade

export interface BillingProvider {
  readonly name: 'stripe' | 'razorpay';
  readonly currency: Currency;

  startSubscription(args: { userId: string; tier: Tier }): Promise<CheckoutHandoff>;
  startTopUp(args: { userId: string; credits: number }): Promise<CheckoutHandoff>;
  cancelSubscription(args: { userId: string }): Promise<{ periodEnd: Date | null }>;
  changeTier(args: { userId: string; toTier: Tier }): Promise<TierChangeResult>;
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors (no consumers yet; we're just declaring types).

- [ ] **Step 3: Commit**

```bash
git add lib/billing/provider.ts
git commit -m "feat(billing): add BillingProvider interface and handoff types"
```

---

### Task 10: `lib/billing/router.ts` `providerFor`

**Files:**
- Create: `lib/billing/router.ts`
- Create: `lib/billing/router.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';

// Stub the razorpay provider so we can assert by reference without
// instantiating the SDK.
const razorpayStub = { name: 'razorpay' as const, currency: 'INR' as const };
vi.mock('./providers/razorpay', () => ({ razorpayProvider: () => razorpayStub }));

import { providerFor } from './router';

type ProfileLike = Parameters<typeof providerFor>[0];
const base: ProfileLike = {
  paymentProvider: null,
  billingCurrency: null,
  billingCountry: null,
} as ProfileLike;

describe('providerFor', () => {
  it('returns the Razorpay provider for IN country (no override)', () => {
    expect(providerFor({ ...base, billingCountry: 'IN' })).toBe(razorpayStub);
  });

  it('returns null for non-IN country with no override (Stripe coming soon)', () => {
    expect(providerFor({ ...base, billingCountry: 'US' })).toBeNull();
  });

  it('returns Razorpay when billingCurrency=INR override is set', () => {
    expect(providerFor({ ...base, billingCountry: 'US', billingCurrency: 'INR' })).toBe(razorpayStub);
  });

  it('returns null when billingCurrency=USD override is set (Stripe coming soon)', () => {
    expect(providerFor({ ...base, billingCountry: 'IN', billingCurrency: 'USD' })).toBeNull();
  });

  it('respects the lock when paymentProvider=razorpay regardless of country/currency', () => {
    expect(providerFor({ ...base, paymentProvider: 'razorpay', billingCountry: 'US' })).toBe(razorpayStub);
  });

  it('returns null when paymentProvider=stripe lock is set (Stripe not wired)', () => {
    expect(providerFor({ ...base, paymentProvider: 'stripe', billingCountry: 'IN' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- lib/billing/router.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `lib/billing/router.ts`**

```ts
/**
 * Selects the BillingProvider for a profile. Lock-first: once
 * `payment_provider` is set on the profile (i.e. user has started a
 * subscription), that wins. Otherwise derive from billing currency, then
 * from country.
 *
 * Returns null when the resolved provider is "Stripe" — Stripe isn't
 * wired yet, so callers surface a friendly "USD billing coming soon"
 * response.
 */

import type { BillingProvider } from './provider';
import { razorpayProvider } from './providers/razorpay';

export type ProfileForRouting = {
  paymentProvider: 'stripe' | 'razorpay' | null;
  billingCurrency: 'INR' | 'USD' | null;
  billingCountry: string | null;
};

export function providerFor(profile: ProfileForRouting): BillingProvider | null {
  const locked = profile.paymentProvider;
  if (locked === 'razorpay') return razorpayProvider();
  if (locked === 'stripe')   return null;

  const currency = profile.billingCurrency
    ?? (profile.billingCountry === 'IN' ? 'INR' : 'USD');
  return currency === 'INR' ? razorpayProvider() : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- lib/billing/router.test.ts
```

Expected: PASS (6 assertions).

- [ ] **Step 5: Commit**

```bash
git add lib/billing/router.ts lib/billing/router.test.ts
git commit -m "feat(billing): add providerFor router with lock-first selection"
```

---

## Phase 4 — Razorpay provider implementation

### Task 11: Razorpay SDK client singleton

**Files:**
- Create: `lib/billing/providers/razorpay/client.ts`

- [ ] **Step 1: Implement the singleton**

```ts
import Razorpay from 'razorpay';
import { env } from '../../../env';

let _client: Razorpay | null = null;

export function getRazorpay(): Razorpay {
  if (_client) return _client;
  if (!env.razorpay.keyId || !env.razorpay.keySecret) {
    throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET is not set');
  }
  _client = new Razorpay({
    key_id: env.razorpay.keyId,
    key_secret: env.razorpay.keySecret,
  });
  return _client;
}

export function razorpayPlanIdFor(tier: 'starter' | 'pro' | 'business'): string | null {
  switch (tier) {
    case 'starter':  return env.razorpay.planStarter;
    case 'pro':      return env.razorpay.planPro;
    case 'business': return env.razorpay.planBusiness;
  }
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/billing/providers/razorpay/client.ts
git commit -m "feat(razorpay): add SDK client singleton and plan-id mapper"
```

---

### Task 12: `ensureRazorpayCustomer`

**Files:**
- Create: `lib/billing/providers/razorpay/customer.ts`
- Create: `lib/billing/providers/razorpay/customer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

type ProfileRow = { id: string; razorpayCustomerId: string | null; email: string | null; displayName: string | null };
let profileRows: ProfileRow[] = [];
const updates: Array<{ id: string; vals: Record<string, unknown> }> = [];

vi.mock('../../../db', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(profileRows),
        }),
      }),
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: (clause: { __whereId: string }) => {
          updates.push({ id: clause.__whereId, vals });
          return Promise.resolve();
        },
      }),
    }),
  }),
}));

vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, val: string) => ({ __whereId: val }),
}));

const createCustomer = vi.fn();
vi.mock('./client', () => ({
  getRazorpay: () => ({ customers: { create: createCustomer } }),
}));

vi.mock('@clerk/nextjs/server', () => ({
  currentUser: vi.fn(),
}));
import { currentUser } from '@clerk/nextjs/server';

import { ensureRazorpayCustomer } from './customer';

describe('ensureRazorpayCustomer', () => {
  beforeEach(() => {
    profileRows = [];
    updates.length = 0;
    createCustomer.mockReset();
    (currentUser as ReturnType<typeof vi.fn>).mockReset();
  });

  it('returns existing customer id without calling Razorpay', async () => {
    profileRows = [{ id: 'u1', razorpayCustomerId: 'cust_existing', email: 'a@b.com', displayName: 'A' }];
    const id = await ensureRazorpayCustomer('u1');
    expect(id).toBe('cust_existing');
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it('creates a Razorpay customer when none exists, then writes id back', async () => {
    profileRows = [{ id: 'u1', razorpayCustomerId: null, email: 'a@b.com', displayName: 'Alex' }];
    (currentUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      emailAddresses: [{ emailAddress: 'a@b.com' }],
      firstName: 'Alex', lastName: 'Doe',
    });
    createCustomer.mockResolvedValue({ id: 'cust_new' });

    const id = await ensureRazorpayCustomer('u1');

    expect(id).toBe('cust_new');
    expect(createCustomer).toHaveBeenCalledWith(expect.objectContaining({
      email: 'a@b.com',
      name: 'Alex Doe',
      notes: { sociafy_user_id: 'u1' },
    }));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: 'u1', vals: { razorpayCustomerId: 'cust_new' } });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- lib/billing/providers/razorpay/customer.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `customer.ts`**

```ts
import { eq } from 'drizzle-orm';
import { currentUser } from '@clerk/nextjs/server';
import { db } from '../../../db';
import { profiles } from '../../../db/schema';
import { getRazorpay } from './client';

/**
 * Returns the Razorpay customer id for a user, creating one on first
 * subscription if needed. Persists the id on `profiles.razorpay_customer_id`.
 */
export async function ensureRazorpayCustomer(userId: string): Promise<string> {
  const [row] = await db()
    .select({
      id: profiles.id,
      razorpayCustomerId: profiles.razorpayCustomerId,
      email: profiles.email,
      displayName: profiles.displayName,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  if (row?.razorpayCustomerId) return row.razorpayCustomerId;

  let email = row?.email ?? undefined;
  let name = row?.displayName ?? undefined;
  try {
    const u = await currentUser();
    email = u?.emailAddresses?.[0]?.emailAddress ?? email;
    const full = [u?.firstName, u?.lastName].filter(Boolean).join(' ');
    name = full || u?.username || name;
  } catch { /* okay */ }

  const customer = await getRazorpay().customers.create({
    email,
    name,
    notes: { sociafy_user_id: userId },
    fail_existing: 0,
  } as Parameters<ReturnType<typeof getRazorpay>['customers']['create']>[0]);

  await db()
    .update(profiles)
    .set({ razorpayCustomerId: customer.id, updatedAt: new Date() })
    .where(eq(profiles.id, userId));

  return customer.id;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- lib/billing/providers/razorpay/customer.test.ts
```

Expected: PASS (2 assertions).

- [ ] **Step 5: Commit**

```bash
git add lib/billing/providers/razorpay/customer.ts lib/billing/providers/razorpay/customer.test.ts
git commit -m "feat(razorpay): add ensureRazorpayCustomer helper"
```

---

### Task 13: `RazorpayProvider.startSubscription`

**Files:**
- Create: `lib/billing/providers/razorpay/index.ts`
- Create: `lib/billing/providers/razorpay/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const subsCreate = vi.fn();
vi.mock('./client', () => ({
  getRazorpay: () => ({ subscriptions: { create: subsCreate } }),
  razorpayPlanIdFor: (tier: string) => ({ starter: 'plan_s', pro: 'plan_p', business: 'plan_b' }[tier]),
}));

vi.mock('./customer', () => ({
  ensureRazorpayCustomer: vi.fn().mockResolvedValue('cust_test'),
}));

vi.mock('../../../env', () => ({
  env: {
    razorpay: {
      keyId: 'rzp_test_key',
      keySecret: 'secret',
      webhookSecret: 'whsec',
      planStarter: 'plan_s', planPro: 'plan_p', planBusiness: 'plan_b',
    },
  },
}));

import { razorpayProvider } from './index';

describe('razorpayProvider.startSubscription', () => {
  beforeEach(() => { subsCreate.mockReset(); });

  it('creates a Razorpay subscription on the right plan and returns a modal handoff', async () => {
    subsCreate.mockResolvedValue({ id: 'sub_abc' });

    const handoff = await razorpayProvider().startSubscription({ userId: 'u1', tier: 'pro' });

    expect(subsCreate).toHaveBeenCalledWith(expect.objectContaining({
      plan_id: 'plan_p',
      customer_id: 'cust_test',
      total_count: 120,
      notes: expect.objectContaining({ sociafy_user_id: 'u1', tier: 'pro' }),
    }));
    expect(handoff).toMatchObject({
      kind: 'razorpay_modal',
      subscriptionId: 'sub_abc',
      keyId: 'rzp_test_key',
      currency: 'INR',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- lib/billing/providers/razorpay/index.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `index.ts` with `startSubscription` only (rest stubbed)**

```ts
/**
 * Razorpay implementation of BillingProvider. Subscriptions use the
 * standard Subscriptions API; top-ups and upgrade-diff payments use
 * Orders. All flows return a `razorpay_modal` handoff the client opens
 * via Razorpay's Standard Checkout JS.
 */

import type { Tier } from '../../../db/schema';
import { TIER_PRICING, TOPUP_PRICING } from '../../pricing';
import type { BillingProvider, CheckoutHandoff, TierChangeResult } from '../../provider';
import { env } from '../../../env';
import { getRazorpay, razorpayPlanIdFor } from './client';
import { ensureRazorpayCustomer } from './customer';

class RazorpayBillingProvider implements BillingProvider {
  readonly name = 'razorpay' as const;
  readonly currency = 'INR' as const;

  async startSubscription({ userId, tier }: { userId: string; tier: Tier }): Promise<CheckoutHandoff> {
    const planId = razorpayPlanIdFor(tier);
    if (!planId) throw new Error(`RAZORPAY_PLAN_${tier.toUpperCase()} is not set`);

    const customerId = await ensureRazorpayCustomer(userId);
    const sub = await getRazorpay().subscriptions.create({
      plan_id: planId,
      customer_id: customerId,
      total_count: 120, // 10 years monthly; subscription cancels normally before this
      customer_notify: 1,
      notes: { sociafy_user_id: userId, tier },
    } as Parameters<ReturnType<typeof getRazorpay>['subscriptions']['create']>[0]);

    return {
      kind: 'razorpay_modal',
      keyId: env.razorpay.keyId!,
      subscriptionId: sub.id,
      amountMinor: TIER_PRICING.INR[tier].amountMinor,
      currency: 'INR',
      description: `Sociafy ${tier} — monthly`,
      prefill: {},
      notes: { sociafy_user_id: userId, tier, kind: 'subscription' },
    };
  }

  async startTopUp(_args: { userId: string; credits: number }): Promise<CheckoutHandoff> {
    throw new Error('not implemented in Task 13 — see Task 14');
  }

  async cancelSubscription(_args: { userId: string }): Promise<{ periodEnd: Date | null }> {
    throw new Error('not implemented in Task 13 — see Task 15');
  }

  async changeTier(_args: { userId: string; toTier: Tier }): Promise<TierChangeResult> {
    throw new Error('not implemented in Task 13 — see Tasks 16-17');
  }
}

let _instance: RazorpayBillingProvider | null = null;
export function razorpayProvider(): RazorpayBillingProvider {
  if (!_instance) _instance = new RazorpayBillingProvider();
  return _instance;
}

// Suppress unused-import lint until later tasks populate the implementations.
void TOPUP_PRICING;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- lib/billing/providers/razorpay/index.test.ts
```

Expected: PASS (1 assertion block, 2 sub-assertions).

- [ ] **Step 5: Commit**

```bash
git add lib/billing/providers/razorpay/index.ts lib/billing/providers/razorpay/index.test.ts
git commit -m "feat(razorpay): implement startSubscription via Subscriptions API"
```

---

### Task 14: `RazorpayProvider.startTopUp`

**Files:**
- Modify: `lib/billing/providers/razorpay/index.ts`
- Modify: `lib/billing/providers/razorpay/index.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `lib/billing/providers/razorpay/index.test.ts`:

```ts
const ordersCreate = vi.fn();
// Re-mock client to expose orders.create as well — extend the mock factory.
// (Vi's vi.mock is hoisted; we override createSubscription's mock object via vi.mocked at top.)
// Simpler: extend the original mock to include orders.
import { getRazorpay } from './client';
const baseRzp = getRazorpay() as unknown as { orders?: { create: typeof ordersCreate } };
baseRzp.orders = { create: ordersCreate };

describe('razorpayProvider.startTopUp', () => {
  beforeEach(() => { ordersCreate.mockReset(); });

  it('rejects credits that are not a positive multiple of 1000', async () => {
    await expect(razorpayProvider().startTopUp({ userId: 'u1', credits: 0 })).rejects.toThrow(/multiple of 1000/);
    await expect(razorpayProvider().startTopUp({ userId: 'u1', credits: 1500 })).rejects.toThrow(/multiple of 1000/);
  });

  it('creates a Razorpay Order priced per 1000-credit pack', async () => {
    ordersCreate.mockResolvedValue({ id: 'order_t1' });

    const handoff = await razorpayProvider().startTopUp({ userId: 'u1', credits: 3000 });

    // 3 packs × ₹1,499 = ₹4,497 = 449700 paise
    expect(ordersCreate).toHaveBeenCalledWith(expect.objectContaining({
      amount: 449700,
      currency: 'INR',
      notes: expect.objectContaining({
        sociafy_user_id: 'u1',
        kind: 'topup',
        credits: '3000',
      }),
    }));
    expect(handoff).toMatchObject({
      kind: 'razorpay_modal',
      orderId: 'order_t1',
      amountMinor: 449700,
      currency: 'INR',
    });
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
npm test -- lib/billing/providers/razorpay/index.test.ts
```

Expected: FAIL with "not implemented in Task 13".

- [ ] **Step 3: Implement `startTopUp` in `index.ts`**

Replace the existing `startTopUp` placeholder with:

```ts
  async startTopUp({ userId, credits }: { userId: string; credits: number }): Promise<CheckoutHandoff> {
    if (credits <= 0 || credits % 1000 !== 0) {
      throw new Error('credits must be a positive multiple of 1000');
    }
    const packs = credits / 1000;
    const amountMinor = TOPUP_PRICING.INR.amountMinor * packs;
    const customerId = await ensureRazorpayCustomer(userId);

    const order = await getRazorpay().orders.create({
      amount: amountMinor,
      currency: 'INR',
      customer_id: customerId,
      notes: {
        sociafy_user_id: userId,
        kind: 'topup',
        credits: String(credits),
      },
    } as Parameters<ReturnType<typeof getRazorpay>['orders']['create']>[0]);

    return {
      kind: 'razorpay_modal',
      keyId: env.razorpay.keyId!,
      orderId: order.id,
      amountMinor,
      currency: 'INR',
      description: `Sociafy top-up — ${credits.toLocaleString()} credits`,
      prefill: {},
      notes: { sociafy_user_id: userId, kind: 'topup', credits: String(credits) },
    };
  }
```

Also remove the `void TOPUP_PRICING;` line at the bottom (now actually used).

- [ ] **Step 4: Run to verify passing**

```bash
npm test -- lib/billing/providers/razorpay/index.test.ts
```

Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add lib/billing/providers/razorpay/index.ts lib/billing/providers/razorpay/index.test.ts
git commit -m "feat(razorpay): implement startTopUp via Orders API"
```

---

### Task 15: `RazorpayProvider.cancelSubscription`

**Files:**
- Modify: `lib/billing/providers/razorpay/index.ts`
- Modify: `lib/billing/providers/razorpay/index.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `lib/billing/providers/razorpay/index.test.ts`:

```ts
const subsCancel = vi.fn();
const dbState = { profile: { razorpaySubscriptionId: null as string | null, subscriptionCurrentPeriodEnd: null as Date | null } };

vi.mock('../../../db', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            razorpaySubscriptionId: dbState.profile.razorpaySubscriptionId,
            subscriptionCurrentPeriodEnd: dbState.profile.subscriptionCurrentPeriodEnd,
          }]),
        }),
      }),
    }),
  }),
}));

vi.mock('drizzle-orm', () => ({ eq: (_c: unknown, v: string) => ({ __whereId: v }) }));

// Extend the existing client mock with subscriptions.cancel.
(baseRzp as unknown as { subscriptions: { cancel: typeof subsCancel } }).subscriptions = {
  ...(baseRzp as unknown as { subscriptions: object }).subscriptions,
  cancel: subsCancel,
};

describe('razorpayProvider.cancelSubscription', () => {
  beforeEach(() => {
    subsCancel.mockReset();
    dbState.profile = { razorpaySubscriptionId: null, subscriptionCurrentPeriodEnd: null };
  });

  it('throws when there is no active razorpay subscription', async () => {
    await expect(razorpayProvider().cancelSubscription({ userId: 'u1' }))
      .rejects.toThrow(/no active razorpay subscription/);
  });

  it('cancels at cycle end and returns the period_end', async () => {
    const periodEnd = new Date('2026-06-01T00:00:00Z');
    dbState.profile = { razorpaySubscriptionId: 'sub_x', subscriptionCurrentPeriodEnd: periodEnd };
    subsCancel.mockResolvedValue({ id: 'sub_x', status: 'cancelled' });

    const result = await razorpayProvider().cancelSubscription({ userId: 'u1' });

    expect(subsCancel).toHaveBeenCalledWith('sub_x', true);
    expect(result).toEqual({ periodEnd });
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
npm test -- lib/billing/providers/razorpay/index.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `cancelSubscription`**

In `lib/billing/providers/razorpay/index.ts`, add these imports near the top:

```ts
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { profiles } from '../../../db/schema';
```

Replace the existing `cancelSubscription` placeholder with:

```ts
  async cancelSubscription({ userId }: { userId: string }): Promise<{ periodEnd: Date | null }> {
    const [row] = await db()
      .select({
        razorpaySubscriptionId: profiles.razorpaySubscriptionId,
        subscriptionCurrentPeriodEnd: profiles.subscriptionCurrentPeriodEnd,
      })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);

    const subId = row?.razorpaySubscriptionId;
    if (!subId) throw new Error('no active razorpay subscription');

    // cancel_at_cycle_end=true → user keeps credits until period_end.
    await getRazorpay().subscriptions.cancel(subId, true);
    return { periodEnd: row.subscriptionCurrentPeriodEnd ?? null };
  }
```

- [ ] **Step 4: Run to verify passing**

```bash
npm test -- lib/billing/providers/razorpay/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/billing/providers/razorpay/index.ts lib/billing/providers/razorpay/index.test.ts
git commit -m "feat(razorpay): implement cancelSubscription (cancel at cycle end)"
```

---

### Task 16: `RazorpayProvider.changeTier` — upgrade path

**Files:**
- Modify: `lib/billing/providers/razorpay/index.ts`
- Modify: `lib/billing/providers/razorpay/index.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `index.test.ts`:

```ts
describe('razorpayProvider.changeTier — upgrade', () => {
  beforeEach(() => {
    ordersCreate.mockReset();
    dbState.profile = { razorpaySubscriptionId: 'sub_old', subscriptionCurrentPeriodEnd: null };
  });

  it('creates an upgrade-diff order and returns an immediate handoff', async () => {
    // Mid-cycle: 15 days remain of a 30-day cycle.
    const now = new Date('2026-05-16T00:00:00Z');
    const periodStart = new Date('2026-05-01T00:00:00Z');
    const periodEnd   = new Date('2026-05-31T00:00:00Z');
    dbState.profile = { razorpaySubscriptionId: 'sub_old', subscriptionCurrentPeriodEnd: periodEnd };

    // Extend mock to expose currentTier + start/end on the profile read.
    (dbState.profile as Record<string, unknown>).tier = 'starter';
    (dbState.profile as Record<string, unknown>).creditCycleStart = periodStart;

    vi.setSystemTime(now);
    ordersCreate.mockResolvedValue({ id: 'order_up' });

    const result = await razorpayProvider().changeTier({ userId: 'u1', toTier: 'pro' });

    // Starter → Pro: 7999 - 2999 = 5000 INR diff, half cycle remaining → 2500 INR = 250000 paise.
    expect(ordersCreate).toHaveBeenCalledWith(expect.objectContaining({
      amount: 250000,
      currency: 'INR',
      notes: expect.objectContaining({
        sociafy_user_id: 'u1',
        kind: 'upgrade_diff',
        from_tier: 'starter',
        to_tier: 'pro',
        old_sub_id: 'sub_old',
      }),
    }));
    expect(result.kind).toBe('immediate');
    if (result.kind === 'immediate') {
      expect(result.handoff).toMatchObject({
        kind: 'razorpay_modal',
        orderId: 'order_up',
        amountMinor: 250000,
      });
    }

    vi.useRealTimers();
  });

  it('skips the diff order if prorated amount is 0 and just signals immediate', async () => {
    const periodStart = new Date('2026-05-01T00:00:00Z');
    const periodEnd   = new Date('2026-05-31T00:00:00Z');
    dbState.profile = { razorpaySubscriptionId: 'sub_old', subscriptionCurrentPeriodEnd: periodEnd };
    (dbState.profile as Record<string, unknown>).tier = 'starter';
    (dbState.profile as Record<string, unknown>).creditCycleStart = periodStart;

    // periodEnd has passed → diff is 0.
    vi.setSystemTime(new Date('2026-06-15T00:00:00Z'));

    const result = await razorpayProvider().changeTier({ userId: 'u1', toTier: 'pro' });

    expect(ordersCreate).not.toHaveBeenCalled();
    expect(result.kind).toBe('immediate');
    if (result.kind === 'immediate') expect(result.handoff).toBeUndefined();

    vi.useRealTimers();
  });
});
```

Update the existing `dbState` mock factory at the top to also return `tier` and `creditCycleStart`:

```ts
vi.mock('../../../db', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            razorpaySubscriptionId: dbState.profile.razorpaySubscriptionId,
            subscriptionCurrentPeriodEnd: dbState.profile.subscriptionCurrentPeriodEnd,
            tier: (dbState.profile as Record<string, unknown>).tier,
            creditCycleStart: (dbState.profile as Record<string, unknown>).creditCycleStart,
          }]),
        }),
      }),
    }),
  }),
}));
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
npm test -- lib/billing/providers/razorpay/index.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `changeTier` upgrade path**

In `lib/billing/providers/razorpay/index.ts`, replace the `changeTier` placeholder with:

```ts
  async changeTier({ userId, toTier }: { userId: string; toTier: Tier }): Promise<TierChangeResult> {
    const [row] = await db()
      .select({
        razorpaySubscriptionId: profiles.razorpaySubscriptionId,
        subscriptionCurrentPeriodEnd: profiles.subscriptionCurrentPeriodEnd,
        tier: profiles.tier,
        creditCycleStart: profiles.creditCycleStart,
      })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);

    if (!row?.razorpaySubscriptionId) throw new Error('no active razorpay subscription');

    const fromTier = row.tier as Tier;
    const isUpgrade = TIER_PRICING.INR[toTier].amountMinor > TIER_PRICING.INR[fromTier].amountMinor;
    const isDowngrade = TIER_PRICING.INR[toTier].amountMinor < TIER_PRICING.INR[fromTier].amountMinor;

    if (!isUpgrade && !isDowngrade) {
      throw new Error('toTier is the same as the current tier');
    }

    if (isUpgrade) {
      const now = new Date();
      const periodStart = row.creditCycleStart;
      const periodEnd = row.subscriptionCurrentPeriodEnd ?? now;
      const amountMinor = proratedDiffMinor({
        oldAmountMinor: TIER_PRICING.INR[fromTier].amountMinor,
        newAmountMinor: TIER_PRICING.INR[toTier].amountMinor,
        now, periodStart, periodEnd,
      });

      if (amountMinor <= 0) {
        // No proration owed (cycle effectively over) — the webhook for the
        // next renewal will swap plans. Caller treats this as immediate.
        return { kind: 'immediate', effectiveAt: now };
      }

      const customerId = await ensureRazorpayCustomer(userId);
      const order = await getRazorpay().orders.create({
        amount: amountMinor,
        currency: 'INR',
        customer_id: customerId,
        notes: {
          sociafy_user_id: userId,
          kind: 'upgrade_diff',
          from_tier: fromTier,
          to_tier: toTier,
          old_sub_id: row.razorpaySubscriptionId,
        },
      } as Parameters<ReturnType<typeof getRazorpay>['orders']['create']>[0]);

      return {
        kind: 'immediate',
        effectiveAt: now,
        handoff: {
          kind: 'razorpay_modal',
          keyId: env.razorpay.keyId!,
          orderId: order.id,
          amountMinor,
          currency: 'INR',
          description: `Upgrade to ${toTier} — prorated`,
          prefill: {},
          notes: {
            sociafy_user_id: userId,
            kind: 'upgrade_diff',
            from_tier: fromTier,
            to_tier: toTier,
            old_sub_id: row.razorpaySubscriptionId,
          },
        },
      };
    }

    // Downgrade path → Task 17.
    throw new Error('not implemented in Task 16 — see Task 17');
  }
```

Add at the top imports of `index.ts`:

```ts
import { proratedDiffMinor } from './proration';
```

- [ ] **Step 4: Run to verify passing**

```bash
npm test -- lib/billing/providers/razorpay/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/billing/providers/razorpay/index.ts lib/billing/providers/razorpay/index.test.ts
git commit -m "feat(razorpay): implement changeTier upgrade with prorated diff order"
```

---

### Task 17: `RazorpayProvider.changeTier` — downgrade path

**Files:**
- Modify: `lib/billing/providers/razorpay/index.ts`
- Modify: `lib/billing/providers/razorpay/index.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `index.test.ts`:

```ts
const updates: Array<{ id: string; vals: Record<string, unknown> }> = [];

// Extend db mock to also capture .update().set().where() — re-mock entirely.
vi.mock('../../../db', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            razorpaySubscriptionId: dbState.profile.razorpaySubscriptionId,
            subscriptionCurrentPeriodEnd: dbState.profile.subscriptionCurrentPeriodEnd,
            tier: (dbState.profile as Record<string, unknown>).tier,
            creditCycleStart: (dbState.profile as Record<string, unknown>).creditCycleStart,
          }]),
        }),
      }),
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: (clause: { __whereId: string }) => {
          updates.push({ id: clause.__whereId, vals });
          return Promise.resolve();
        },
      }),
    }),
  }),
}));

describe('razorpayProvider.changeTier — downgrade', () => {
  beforeEach(() => {
    subsCancel.mockReset();
    updates.length = 0;
    const periodEnd = new Date('2026-06-01T00:00:00Z');
    dbState.profile = { razorpaySubscriptionId: 'sub_old', subscriptionCurrentPeriodEnd: periodEnd };
    (dbState.profile as Record<string, unknown>).tier = 'business';
    (dbState.profile as Record<string, unknown>).creditCycleStart = new Date('2026-05-01T00:00:00Z');
  });

  it('cancels at cycle end and stores pendingTierChange', async () => {
    subsCancel.mockResolvedValue({ id: 'sub_old', status: 'cancelled' });

    const result = await razorpayProvider().changeTier({ userId: 'u1', toTier: 'pro' });

    expect(subsCancel).toHaveBeenCalledWith('sub_old', true);
    expect(updates[0].vals).toMatchObject({
      pendingTierChangeTo: 'pro',
      pendingTierChangeAt: new Date('2026-06-01T00:00:00Z'),
    });
    expect(result).toMatchObject({
      kind: 'scheduled',
      effectiveAt: new Date('2026-06-01T00:00:00Z'),
    });
  });
});
```

- [ ] **Step 2: Run to verify the new test fails**

```bash
npm test -- lib/billing/providers/razorpay/index.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement downgrade path**

In `lib/billing/providers/razorpay/index.ts`, replace the final `throw new Error('not implemented in Task 16 — see Task 17');` with:

```ts
    // Downgrade: schedule at cycle end.
    const periodEnd = row.subscriptionCurrentPeriodEnd;
    if (!periodEnd) throw new Error('cannot downgrade — missing period_end');

    await getRazorpay().subscriptions.cancel(row.razorpaySubscriptionId, true);
    await db()
      .update(profiles)
      .set({
        pendingTierChangeTo: toTier,
        pendingTierChangeAt: periodEnd,
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, userId));

    return { kind: 'scheduled', effectiveAt: periodEnd };
```

- [ ] **Step 4: Run to verify passing**

```bash
npm test -- lib/billing/providers/razorpay/index.test.ts
```

Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add lib/billing/providers/razorpay/index.ts lib/billing/providers/razorpay/index.test.ts
git commit -m "feat(razorpay): implement changeTier downgrade (cancel at cycle end)"
```

---

## Phase 5 — Razorpay webhook

### Task 18: `/api/razorpay/webhook` route

**Files:**
- Create: `app/api/razorpay/webhook/route.ts`
- Create: `app/api/razorpay/webhook/route.test.ts`

- [ ] **Step 1: Write the failing test (signature verification + happy paths)**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('../../../../lib/env', () => ({
  env: { razorpay: { webhookSecret: 'whsec_test' } },
  isStubMode: { razorpay: () => false },
}));

const applyState = vi.fn();
const grantIdempotent = vi.fn();
vi.mock('../../../../lib/billing/state', () => ({ applySubscriptionState: applyState }));
vi.mock('../../../../lib/credits/ledger', () => ({ grantIdempotent }));

import { POST } from './route';

function sign(body: string): string {
  return crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex');
}

function makeReq(body: string, sig: string) {
  return new Request('http://test/api/razorpay/webhook', {
    method: 'POST',
    headers: { 'x-razorpay-signature': sig },
    body,
  }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/razorpay/webhook', () => {
  beforeEach(() => {
    applyState.mockReset();
    grantIdempotent.mockReset();
  });

  it('rejects requests with a bad signature (400)', async () => {
    const body = JSON.stringify({ event: 'subscription.activated' });
    const res = await POST(makeReq(body, 'wrong_sig'));
    expect(res.status).toBe(400);
  });

  it('grants credits on subscription.activated (idempotent on event id)', async () => {
    const body = JSON.stringify({
      event: 'subscription.activated',
      payload: {
        subscription: {
          entity: {
            id: 'sub_x', status: 'active', plan_id: 'plan_p',
            current_end: Math.floor(new Date('2026-06-01').getTime() / 1000),
            notes: { sociafy_user_id: 'u1', tier: 'pro' },
            customer_id: 'cust_a',
          },
        },
      },
    });
    grantIdempotent.mockResolvedValue(true);

    const res = await POST(makeReq(body, sign(body)));

    expect(res.status).toBe(200);
    expect(applyState).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      provider: 'razorpay',
      status: 'active',
      tier: 'pro',
      providerCustomerId: 'cust_a',
      providerSubscriptionId: 'sub_x',
    }));
    expect(grantIdempotent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      kind: 'monthly_grant',
      credits: 6000,
      source: 'rzp_sub:sub_x:activated',
    }));
  });

  it('grants top-up credits on payment.captured with notes.kind=topup', async () => {
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_t1',
            notes: { sociafy_user_id: 'u1', kind: 'topup', credits: '2000' },
          },
        },
      },
    });
    grantIdempotent.mockResolvedValue(true);

    const res = await POST(makeReq(body, sign(body)));

    expect(res.status).toBe(200);
    expect(grantIdempotent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      kind: 'topup',
      credits: 2000,
      source: 'rzp_topup:pay_t1',
    }));
  });

  it('returns 200 for unhandled events without DB writes', async () => {
    const body = JSON.stringify({ event: 'refund.created', payload: {} });
    const res = await POST(makeReq(body, sign(body)));
    expect(res.status).toBe(200);
    expect(applyState).not.toHaveBeenCalled();
    expect(grantIdempotent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- app/api/razorpay/webhook/route.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the route**

Create `app/api/razorpay/webhook/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { env, isStubMode } from '../../../../lib/env';
import { TIER_CREDITS, type Tier } from '../../../../lib/db/schema';
import { applySubscriptionState } from '../../../../lib/billing/state';
import { grantIdempotent } from '../../../../lib/credits/ledger';
import { normalizeRazorpayStatus, type RazorpaySubscriptionStatus } from '../../../../lib/billing/providers/razorpay/status';

export const runtime = 'nodejs';

/**
 * Razorpay webhook. Mirrors subscription state into profiles and writes
 * idempotent credit grants into credit_ledger. Signature verification is
 * mandatory before any DB write.
 *
 * Events handled: subscription.activated, subscription.charged,
 * subscription.updated, subscription.cancelled, subscription.completed,
 * subscription.halted, subscription.paused, payment.captured.
 *
 * Idempotency: meta.source on every grant carries the Razorpay event /
 * payment id so retried deliveries do not double-credit.
 */
export async function POST(req: NextRequest) {
  if (isStubMode.razorpay()) {
    return NextResponse.json({ error: 'razorpay_not_configured' }, { status: 503 });
  }

  const sig = req.headers.get('x-razorpay-signature');
  if (!sig) return NextResponse.json({ error: 'missing_signature' }, { status: 400 });

  const body = await req.text();
  const expected = crypto
    .createHmac('sha256', env.razorpay.webhookSecret!)
    .update(body)
    .digest('hex');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  let event: { event: string; payload: Record<string, unknown> };
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    switch (event.event) {
      case 'subscription.activated': await handleSubActivated(event.payload); break;
      case 'subscription.charged':   await handleSubCharged(event.payload);   break;
      case 'subscription.updated':   await handleSubUpdated(event.payload);   break;
      case 'subscription.cancelled': await handleSubCancelled(event.payload); break;
      case 'subscription.completed': await handleSubCompleted(event.payload); break;
      case 'subscription.halted':
      case 'subscription.paused':    await handleSubPastDue(event.payload);   break;
      case 'payment.captured':       await handlePaymentCaptured(event.payload); break;
      default: /* 2xx no-op */
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[razorpay.webhook] ${event.event} failed:`, msg);
    return NextResponse.json({ error: 'handler_failed', detail: msg }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

type SubEntity = {
  id: string;
  status: RazorpaySubscriptionStatus;
  plan_id: string;
  current_end?: number;
  customer_id?: string;
  notes?: { sociafy_user_id?: string; tier?: Tier; [k: string]: unknown };
};

function readSub(payload: Record<string, unknown>): SubEntity {
  const sub = (payload.subscription as { entity: SubEntity } | undefined)?.entity;
  if (!sub) throw new Error('payload.subscription.entity missing');
  return sub;
}

function tierFromPlanId(planId: string): Tier | null {
  if (planId === env.razorpay.planStarter)  return 'starter';
  if (planId === env.razorpay.planPro)      return 'pro';
  if (planId === env.razorpay.planBusiness) return 'business';
  return null;
}

function tsToDate(ts: number | undefined): Date | null {
  return typeof ts === 'number' ? new Date(ts * 1000) : null;
}

async function handleSubActivated(payload: Record<string, unknown>) {
  const sub = readSub(payload);
  const userId = sub.notes?.sociafy_user_id;
  const tier = sub.notes?.tier ?? tierFromPlanId(sub.plan_id);
  if (!userId || !tier) return;

  await applySubscriptionState({
    userId,
    provider: 'razorpay',
    status: normalizeRazorpayStatus(sub.status),
    tier,
    periodEnd: tsToDate(sub.current_end),
    providerCustomerId: sub.customer_id,
    providerSubscriptionId: sub.id,
  });
  await grantIdempotent({
    userId,
    kind: 'monthly_grant',
    credits: TIER_CREDITS[tier],
    source: `rzp_sub:${sub.id}:activated`,
    meta: { reason: 'first_purchase', tier, subscriptionId: sub.id },
  });
}

async function handleSubCharged(payload: Record<string, unknown>) {
  const sub = readSub(payload);
  const payment = (payload.payment as { entity: { id: string } } | undefined)?.entity;
  const userId = sub.notes?.sociafy_user_id;
  const tier = sub.notes?.tier ?? tierFromPlanId(sub.plan_id);
  if (!userId || !tier || !payment) return;

  await applySubscriptionState({
    userId,
    provider: 'razorpay',
    status: 'active',
    tier,
    periodEnd: tsToDate(sub.current_end),
    providerSubscriptionId: sub.id,
  });
  await grantIdempotent({
    userId,
    kind: 'monthly_grant',
    credits: TIER_CREDITS[tier],
    source: `rzp_sub:${sub.id}:${payment.id}`,
    meta: { reason: 'monthly_renewal', tier, subscriptionId: sub.id, paymentId: payment.id },
  });
}

async function handleSubUpdated(payload: Record<string, unknown>) {
  const sub = readSub(payload);
  const userId = sub.notes?.sociafy_user_id;
  if (!userId) return;
  await applySubscriptionState({
    userId,
    provider: 'razorpay',
    status: normalizeRazorpayStatus(sub.status),
    tier: null,
    periodEnd: tsToDate(sub.current_end),
    providerSubscriptionId: sub.id,
  });
}

async function handleSubCancelled(payload: Record<string, unknown>) {
  const sub = readSub(payload);
  const userId = sub.notes?.sociafy_user_id;
  if (!userId) return;
  await applySubscriptionState({
    userId,
    provider: 'razorpay',
    status: 'canceled',
    tier: null,
    periodEnd: tsToDate(sub.current_end),
    providerSubscriptionId: sub.id,
  });
}

async function handleSubCompleted(payload: Record<string, unknown>) {
  // For pure cancels this is a no-op beyond marking canceled. The
  // pending-tier-change handoff (downgrade) is wired separately in a
  // future iteration that reads pending_tier_change_to on profile and
  // creates the new subscription. For Task 18 we just mirror state.
  await handleSubCancelled(payload);
}

async function handleSubPastDue(payload: Record<string, unknown>) {
  const sub = readSub(payload);
  const userId = sub.notes?.sociafy_user_id;
  if (!userId) return;
  await applySubscriptionState({
    userId,
    provider: 'razorpay',
    status: 'past_due',
    tier: null,
    periodEnd: tsToDate(sub.current_end),
    providerSubscriptionId: sub.id,
  });
}

async function handlePaymentCaptured(payload: Record<string, unknown>) {
  const payment = (payload.payment as { entity: {
    id: string;
    notes?: { sociafy_user_id?: string; kind?: string; credits?: string; [k: string]: unknown };
  } } | undefined)?.entity;
  if (!payment) return;
  const userId = payment.notes?.sociafy_user_id;
  const kind = payment.notes?.kind;
  if (!userId) return;

  if (kind === 'topup') {
    const credits = Number(payment.notes?.credits ?? '0');
    if (credits <= 0) return;
    await grantIdempotent({
      userId,
      kind: 'topup',
      credits,
      source: `rzp_topup:${payment.id}`,
      meta: { reason: 'topup', paymentId: payment.id },
    });
  }
  // kind === 'upgrade_diff' handoff (cancel old sub + create new) is
  // handled in a follow-up iteration. For Task 18 we accept the payment
  // and rely on the next subscription.charged for the new plan.
}
```

- [ ] **Step 4: Run to verify passing**

```bash
npm test -- app/api/razorpay/webhook/route.test.ts
```

Expected: PASS (4 assertions).

- [ ] **Step 5: Commit**

```bash
git add app/api/razorpay/webhook/route.ts app/api/razorpay/webhook/route.test.ts
git commit -m "feat(razorpay): add signature-verified webhook with idempotent grants"
```

---

### Task 18b: Wire upgrade-diff and pending-downgrade completion in the webhook

**Files:**
- Modify: `app/api/razorpay/webhook/route.ts`
- Modify: `app/api/razorpay/webhook/route.test.ts`
- Modify: `lib/billing/providers/razorpay/index.ts`

- [ ] **Step 1: Add failing tests for the two new flows**

Append to `route.test.ts`:

```ts
const subsCreate = vi.fn();
const subsCancel = vi.fn();
vi.mock('../../../../lib/billing/providers/razorpay/client', () => ({
  getRazorpay: () => ({ subscriptions: { create: subsCreate, cancel: subsCancel } }),
  razorpayPlanIdFor: (tier: string) => ({ starter: 'plan_s', pro: 'plan_p', business: 'plan_b' }[tier]),
}));

const profileRow: { tier?: string; razorpayCustomerId?: string; pendingTierChangeTo?: string | null } = {};
const updates: Array<Record<string, unknown>> = [];
vi.mock('../../../../lib/db', () => ({
  db: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([profileRow]) }) }),
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({ where: () => { updates.push(vals); return Promise.resolve(); } }),
    }),
  }),
}));

describe('payment.captured with notes.kind=upgrade_diff', () => {
  beforeEach(() => {
    subsCreate.mockReset();
    subsCancel.mockReset();
    grantIdempotent.mockReset();
    applyState.mockReset();
    profileRow.razorpayCustomerId = 'cust_x';
    profileRow.tier = 'starter';
  });

  it('cancels the old sub, creates a new sub on the target plan, and grants the delta', async () => {
    subsCreate.mockResolvedValue({ id: 'sub_new', status: 'active', plan_id: 'plan_p' });
    grantIdempotent.mockResolvedValue(true);

    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: { entity: {
          id: 'pay_up1',
          notes: {
            sociafy_user_id: 'u1',
            kind: 'upgrade_diff',
            from_tier: 'starter',
            to_tier: 'pro',
            old_sub_id: 'sub_old',
          },
        } },
      },
    });

    const res = await POST(makeReq(body, sign(body)));
    expect(res.status).toBe(200);
    expect(subsCancel).toHaveBeenCalledWith('sub_old', false);
    expect(subsCreate).toHaveBeenCalledWith(expect.objectContaining({
      plan_id: 'plan_p',
      customer_id: 'cust_x',
      notes: expect.objectContaining({ sociafy_user_id: 'u1', tier: 'pro' }),
    }));
    expect(grantIdempotent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'monthly_grant',
      credits: 4000, // delta starter → pro
      source: 'rzp_upgrade:pay_up1',
    }));
  });
});

describe('subscription.completed with a pending downgrade', () => {
  beforeEach(() => {
    subsCreate.mockReset();
    grantIdempotent.mockReset();
    profileRow.razorpayCustomerId = 'cust_x';
    profileRow.pendingTierChangeTo = 'pro';
  });

  it('creates a new sub on the pending plan and clears the pending flag', async () => {
    subsCreate.mockResolvedValue({ id: 'sub_next', status: 'active', plan_id: 'plan_p' });

    const body = JSON.stringify({
      event: 'subscription.completed',
      payload: { subscription: { entity: {
        id: 'sub_done', status: 'completed', plan_id: 'plan_b',
        notes: { sociafy_user_id: 'u1', tier: 'business' },
      } } },
    });

    const res = await POST(makeReq(body, sign(body)));
    expect(res.status).toBe(200);
    expect(subsCreate).toHaveBeenCalledWith(expect.objectContaining({
      plan_id: 'plan_p',
      customer_id: 'cust_x',
      notes: expect.objectContaining({ sociafy_user_id: 'u1', tier: 'pro' }),
    }));
    const clearUpdate = updates.find((u) => u.pendingTierChangeTo === null);
    expect(clearUpdate).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
npm test -- app/api/razorpay/webhook/route.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement upgrade-diff payment handling and pending-downgrade completion**

In `app/api/razorpay/webhook/route.ts`, expand `handlePaymentCaptured` and `handleSubCompleted`:

Add at the top imports:

```ts
import { eq } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { profiles } from '../../../../lib/db/schema';
import { getRazorpay, razorpayPlanIdFor } from '../../../../lib/billing/providers/razorpay/client';
import { deltaCredits } from '../../../../lib/billing/providers/razorpay/proration';
```

Replace `handleSubCompleted` with:

```ts
async function handleSubCompleted(payload: Record<string, unknown>) {
  const sub = readSub(payload);
  const userId = sub.notes?.sociafy_user_id;
  if (!userId) return;

  const [row] = await db()
    .select({
      pendingTo: profiles.pendingTierChangeTo,
      customerId: profiles.razorpayCustomerId,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  const pendingTo = row?.pendingTo as Tier | null;
  if (pendingTo && row?.customerId) {
    const planId = razorpayPlanIdFor(pendingTo);
    if (planId) {
      const next = await getRazorpay().subscriptions.create({
        plan_id: planId,
        customer_id: row.customerId,
        total_count: 120,
        customer_notify: 1,
        notes: { sociafy_user_id: userId, tier: pendingTo },
      } as Parameters<ReturnType<typeof getRazorpay>['subscriptions']['create']>[0]);

      await applySubscriptionState({
        userId,
        provider: 'razorpay',
        status: 'incomplete',
        tier: pendingTo,
        periodEnd: null,
        providerSubscriptionId: next.id,
      });
      await db()
        .update(profiles)
        .set({ pendingTierChangeTo: null, pendingTierChangeAt: null, updatedAt: new Date() })
        .where(eq(profiles.id, userId));
      return;
    }
  }

  // No pending change → behave like cancel.
  await handleSubCancelled(payload);
}
```

Replace `handlePaymentCaptured` with:

```ts
async function handlePaymentCaptured(payload: Record<string, unknown>) {
  const payment = (payload.payment as { entity: {
    id: string;
    notes?: {
      sociafy_user_id?: string;
      kind?: string;
      credits?: string;
      from_tier?: Tier;
      to_tier?: Tier;
      old_sub_id?: string;
      [k: string]: unknown;
    };
  } } | undefined)?.entity;
  if (!payment) return;
  const notes = payment.notes ?? {};
  const userId = notes.sociafy_user_id;
  if (!userId) return;

  if (notes.kind === 'topup') {
    const credits = Number(notes.credits ?? '0');
    if (credits <= 0) return;
    await grantIdempotent({
      userId,
      kind: 'topup',
      credits,
      source: `rzp_topup:${payment.id}`,
      meta: { reason: 'topup', paymentId: payment.id },
    });
    return;
  }

  if (notes.kind === 'upgrade_diff' && notes.from_tier && notes.to_tier && notes.old_sub_id) {
    const [row] = await db()
      .select({ customerId: profiles.razorpayCustomerId })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1);
    if (!row?.customerId) return;

    const planId = razorpayPlanIdFor(notes.to_tier);
    if (!planId) return;

    try { await getRazorpay().subscriptions.cancel(notes.old_sub_id, false); } catch { /* okay */ }

    const next = await getRazorpay().subscriptions.create({
      plan_id: planId,
      customer_id: row.customerId,
      total_count: 120,
      customer_notify: 1,
      notes: { sociafy_user_id: userId, tier: notes.to_tier },
    } as Parameters<ReturnType<typeof getRazorpay>['subscriptions']['create']>[0]);

    await applySubscriptionState({
      userId,
      provider: 'razorpay',
      status: 'active',
      tier: notes.to_tier,
      periodEnd: null,
      providerSubscriptionId: next.id,
    });

    const delta = deltaCredits(notes.from_tier, notes.to_tier);
    if (delta > 0) {
      await grantIdempotent({
        userId,
        kind: 'monthly_grant',
        credits: delta,
        source: `rzp_upgrade:${payment.id}`,
        meta: { reason: 'upgrade_delta', fromTier: notes.from_tier, toTier: notes.to_tier, paymentId: payment.id },
      });
    }
  }
}
```

- [ ] **Step 4: Run to verify passing**

```bash
npm test -- app/api/razorpay/webhook/route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/razorpay/webhook/route.ts app/api/razorpay/webhook/route.test.ts
git commit -m "feat(razorpay): handle upgrade_diff payments and pending-downgrade completion"
```

---

## Phase 6 — Stripe webhook refactor (preserve behavior)

### Task 19: Refactor Stripe webhook to use shared helpers

**Files:**
- Modify: `app/api/stripe/webhook/route.ts`

- [ ] **Step 1: Read the current Stripe webhook to identify the inline helpers**

Open `app/api/stripe/webhook/route.ts`. Note: `grantIfNew` is defined inline at the bottom of the file. It scans recent monthly_grant rows for `meta.source` matches — exactly what `grantIdempotent` now does.

- [ ] **Step 2: Replace `grantIfNew` call sites with `grantIdempotent`**

Add to imports at the top:

```ts
import { grantIdempotent } from '../../../../lib/credits/ledger';
import { applySubscriptionState } from '../../../../lib/billing/state';
```

Replace each `await grantIfNew({ ... })` call with the corresponding `applySubscriptionState` + `grantIdempotent` calls. Concretely:

In `handleCheckoutCompleted`, replace the existing `db().update(profiles).set({...})` and the subsequent `await grantIfNew({...})` with:

```ts
  await applySubscriptionState({
    userId,
    provider: 'stripe',
    status: 'active',
    tier,
    periodEnd: subPeriodEnd(sub),
    providerCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id ?? undefined,
    providerSubscriptionId: subscriptionId,
  });
  await db()
    .update(profiles)
    .set({ creditCycleStart: new Date() })
    .where(eq(profiles.id, userId));

  await grantIdempotent({
    userId,
    kind: 'monthly_grant',
    credits: TIER_CREDITS[tier],
    source: `checkout:${event.id}`,
    meta: { reason: 'first_purchase', tier, subscriptionId, sessionId: session.id },
  });
```

Apply the same pattern in `handleInvoicePaid` (use `source: 'invoice:${invoice.id}'`) and `handleSubscriptionUpdated` / `handleSubscriptionDeleted` (state-only updates via `applySubscriptionState` with `tier: null` where appropriate).

Delete the `grantIfNew` function at the bottom of the file (now unused).

- [ ] **Step 3: Verify the file compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Lint**

```bash
npm run lint
```

Expected: no new warnings.

- [ ] **Step 5: Commit**

```bash
git add app/api/stripe/webhook/route.ts
git commit -m "refactor(stripe): use shared grantIdempotent + applySubscriptionState"
```

---

## Phase 7 — New API routes

### Task 20: `POST /api/billing/preferences`

**Files:**
- Create: `app/api/billing/preferences/route.ts`

- [ ] **Step 1: Implement the route**

```ts
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { db } from '../../../../lib/db';
import { profiles } from '../../../../lib/db/schema';

export const runtime = 'nodejs';

const bodySchema = z.object({
  currency: z.enum(['INR', 'USD']),
});

/**
 * POST /api/billing/preferences
 *
 * Sets the user's billing_currency override. Locked once a subscription
 * is active — returns 409 with the active provider so the UI can surface
 * a "cancel first" message.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(bodySchema, raw);
    if (!parsed.ok) return parsed.response;

    const [profile] = await db()
      .select({ status: profiles.subscriptionStatus, provider: profiles.paymentProvider })
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);

    if (profile?.status === 'active' && profile?.provider) {
      return jsonError('subscription_active', 409, {
        hint: 'Cancel your current subscription before changing currency.',
        provider: profile.provider,
      });
    }

    await db()
      .update(profiles)
      .set({ billingCurrency: parsed.data.currency, updatedAt: new Date() })
      .where(eq(profiles.id, user.id));

    return { currency: parsed.data.currency, stripeComingSoon: parsed.data.currency === 'USD' };
  }, req);
}
```

- [ ] **Step 2: Verify it type-checks and lints**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/billing/preferences/route.ts
git commit -m "feat(billing): add /preferences route with active-sub lock"
```

---

### Task 21: `POST /api/billing/cancel`

**Files:**
- Create: `app/api/billing/cancel/route.ts`

- [ ] **Step 1: Implement the route**

```ts
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { profiles } from '../../../../lib/db/schema';
import { providerFor } from '../../../../lib/billing/router';

export const runtime = 'nodejs';

/**
 * POST /api/billing/cancel — cancel the active subscription at cycle end.
 * Credits remain usable until subscription_current_period_end.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const [profile] = await db()
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);

    if (!profile || profile.subscriptionStatus !== 'active') {
      return jsonError('no_active_subscription', 400);
    }

    const provider = providerFor({
      paymentProvider: profile.paymentProvider as 'stripe' | 'razorpay' | null,
      billingCurrency: profile.billingCurrency as 'INR' | 'USD' | null,
      billingCountry: profile.billingCountry,
    });
    if (!provider) {
      return jsonError('billing_coming_soon', 503, { hint: 'Stripe cancellation is not wired yet.' });
    }

    const result = await provider.cancelSubscription({ userId: user.id });
    return { periodEnd: result.periodEnd?.toISOString() ?? null };
  }, req);
}
```

- [ ] **Step 2: Type-check and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/billing/cancel/route.ts
git commit -m "feat(billing): add /cancel route delegating to provider"
```

---

### Task 22: `POST /api/billing/change-tier` + `DELETE` to clear pending

**Files:**
- Create: `app/api/billing/change-tier/route.ts`

- [ ] **Step 1: Implement both handlers**

```ts
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { db } from '../../../../lib/db';
import { profiles, TIERS } from '../../../../lib/db/schema';
import { providerFor } from '../../../../lib/billing/router';

export const runtime = 'nodejs';

const bodySchema = z.object({ toTier: z.enum(TIERS) });

/**
 * POST /api/billing/change-tier
 *
 * Upgrade or downgrade an active subscription. Provider decides
 * proration / scheduling per the spec §8.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(bodySchema, raw);
    if (!parsed.ok) return parsed.response;

    const [profile] = await db()
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);

    if (!profile || profile.subscriptionStatus !== 'active') {
      return jsonError('no_active_subscription', 400);
    }
    if (profile.tier === parsed.data.toTier) {
      return jsonError('same_tier', 400);
    }

    const provider = providerFor({
      paymentProvider: profile.paymentProvider as 'stripe' | 'razorpay' | null,
      billingCurrency: profile.billingCurrency as 'INR' | 'USD' | null,
      billingCountry: profile.billingCountry,
    });
    if (!provider) {
      return jsonError('billing_coming_soon', 503);
    }

    const result = await provider.changeTier({ userId: user.id, toTier: parsed.data.toTier });
    return result;
  }, req);
}

/**
 * DELETE /api/billing/change-tier
 *
 * Clear a pending tier change (the "Cancel switch" button). Per spec
 * §8.3 step 6, this only clears the local flag — the underlying
 * Razorpay cancellation (cancel_at_cycle_end) is one-way, so the
 * caller must re-subscribe before period_end to keep service
 * uninterrupted. The route returns a `caveat` field the UI surfaces
 * to the user.
 */
export async function DELETE(req: NextRequest) {
  return withUser(async (user) => {
    await db()
      .update(profiles)
      .set({ pendingTierChangeTo: null, pendingTierChangeAt: null, updatedAt: new Date() })
      .where(eq(profiles.id, user.id));

    return {
      cleared: true,
      caveat: 'Your Razorpay subscription will still end on its scheduled date. Re-subscribe before then to keep service uninterrupted.',
    };
  }, req);
}
```

- [ ] **Step 2: Type-check and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/billing/change-tier/route.ts
git commit -m "feat(billing): add /change-tier route delegating to provider"
```

---

### Task 23: `POST /api/billing/topup`

**Files:**
- Create: `app/api/billing/topup/route.ts`

- [ ] **Step 1: Implement the route**

```ts
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { db } from '../../../../lib/db';
import { profiles } from '../../../../lib/db/schema';
import { providerFor } from '../../../../lib/billing/router';

export const runtime = 'nodejs';

const bodySchema = z.object({
  credits: z.number().int().min(1000).max(100000)
    .refine((n) => n % 1000 === 0, 'credits must be a multiple of 1000'),
});

/**
 * POST /api/billing/topup — one-time credit pack purchase.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(bodySchema, raw);
    if (!parsed.ok) return parsed.response;

    const [profile] = await db()
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);
    if (!profile) return jsonError('profile_not_found', 404);

    const provider = providerFor({
      paymentProvider: profile.paymentProvider as 'stripe' | 'razorpay' | null,
      billingCurrency: profile.billingCurrency as 'INR' | 'USD' | null,
      billingCountry: profile.billingCountry,
    });
    if (!provider) return jsonError('billing_coming_soon', 503);

    const handoff = await provider.startTopUp({ userId: user.id, credits: parsed.data.credits });
    return handoff;
  }, req);
}
```

- [ ] **Step 2: Type-check and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/billing/topup/route.ts
git commit -m "feat(billing): add /topup route for one-time credit packs"
```

---

### Task 24: Refactor `POST /api/billing/checkout`

**Files:**
- Modify: `app/api/billing/checkout/route.ts`

- [ ] **Step 1: Replace the Stripe-specific body with provider dispatch**

Replace the entire file body (keeping the imports section adjusted) with:

```ts
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { db } from '../../../../lib/db';
import { profiles, TIERS } from '../../../../lib/db/schema';
import { providerFor } from '../../../../lib/billing/router';

export const runtime = 'nodejs';

const bodySchema = z.object({ tier: z.enum(TIERS) });

/**
 * POST /api/billing/checkout — start a subscription checkout for the
 * requested tier. Returns a CheckoutHandoff the client opens (URL
 * redirect for Stripe, modal params for Razorpay).
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(bodySchema, raw);
    if (!parsed.ok) return parsed.response;

    const [profile] = await db()
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);
    if (!profile) return jsonError('profile_not_found', 404);

    const provider = providerFor({
      paymentProvider: profile.paymentProvider as 'stripe' | 'razorpay' | null,
      billingCurrency: profile.billingCurrency as 'INR' | 'USD' | null,
      billingCountry: profile.billingCountry,
    });
    if (!provider) {
      return jsonError('billing_coming_soon', 503, {
        hint: 'USD billing via Stripe is coming soon. Use the "Pay in INR via Razorpay" option.',
      });
    }

    const handoff = await provider.startSubscription({ userId: user.id, tier: parsed.data.tier });
    return handoff;
  }, req);
}
```

- [ ] **Step 2: Type-check and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/billing/checkout/route.ts
git commit -m "refactor(billing): delegate /checkout to providerFor"
```

---

### Task 25: Extend `GET /api/billing` response

**Files:**
- Modify: `app/api/billing/route.ts`

- [ ] **Step 1: Update the route to include currency / provider / pending-tier-change and write-through billing_country**

Replace the file body:

```ts
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { profiles, TIER_CREDITS, type Tier } from '../../../lib/db/schema';
import { getBalance } from '../../../lib/credits/ledger';
import { isStubMode, devForcedCountry } from '../../../lib/env';
import { TIER_PRICING, formatPrice, type Currency } from '../../../lib/billing/pricing';

export const runtime = 'nodejs';

/**
 * GET /api/billing — snapshot of the user's billing state for the UI.
 */
export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    // Detect country from Vercel geo header (or dev override).
    const detectedCountry =
      req.headers.get('x-vercel-ip-country')?.toUpperCase()
      ?? devForcedCountry()
      ?? null;

    const [profile] = await db()
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);

    // Write-through: stamp billing_country on first visit, never overwrite.
    if (profile && !profile.billingCountry && detectedCountry) {
      await db()
        .update(profiles)
        .set({ billingCountry: detectedCountry, updatedAt: new Date() })
        .where(eq(profiles.id, user.id));
      profile.billingCountry = detectedCountry;
    }

    const tier = (profile?.tier ?? 'starter') as Tier;
    const balance = await getBalance(user.id);
    const isIndia = (profile?.billingCountry ?? detectedCountry) === 'IN';
    const currency: Currency = (profile?.billingCurrency as Currency | null)
      ?? (isIndia ? 'INR' : 'USD');
    const provider: 'razorpay' | 'stripe' | null = profile?.paymentProvider
      ?? (currency === 'INR' ? 'razorpay' : null);
    const hasActiveSubscription = profile?.subscriptionStatus === 'active';
    const canSwitchProvider = !hasActiveSubscription;

    return {
      currentTier: tier,
      currentTierLabel: tier.charAt(0).toUpperCase() + tier.slice(1),
      monthlyAllocation: TIER_CREDITS[tier],
      balance,
      subscriptionStatus: profile?.subscriptionStatus ?? null,
      subscriptionCurrentPeriodEnd: profile?.subscriptionCurrentPeriodEnd?.toISOString() ?? null,
      stripeCustomerId: profile?.stripeCustomerId ?? null,
      razorpayCustomerId: profile?.razorpayCustomerId ?? null,
      hasActiveSubscription,
      billingConfigured: !isStubMode.razorpay(),
      currency,
      provider,
      isIndia,
      canSwitchProvider,
      pendingTierChange: profile?.pendingTierChangeTo ? {
        toTier: profile.pendingTierChangeTo,
        at: profile.pendingTierChangeAt?.toISOString() ?? null,
      } : null,
      tiers: (['starter', 'pro', 'business'] as Tier[]).map((t) => ({
        tier: t,
        label: t.charAt(0).toUpperCase() + t.slice(1),
        priceMonthly: formatPrice(currency, t),
        amountMinor: TIER_PRICING[currency][t].amountMinor,
        credits: TIER_CREDITS[t],
        isCurrent: t === tier,
      })),
    };
  }, req);
}
```

- [ ] **Step 2: Type-check and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/billing/route.ts
git commit -m "feat(billing): extend GET /api/billing with currency/provider/pending"
```

---

## Phase 8 — UI

### Task 26: Razorpay checkout component

**Files:**
- Create: `components/billing/razorpay-checkout.tsx`

- [ ] **Step 1: Implement the script loader + modal launcher**

```tsx
'use client';

/**
 * Loads Razorpay Standard Checkout once per browser session and opens a
 * modal from a `razorpay_modal` CheckoutHandoff. The component itself
 * renders nothing — call `openRazorpayModal(handoff, callbacks)` from a
 * click handler.
 */

type RazorpayHandoff = {
  kind: 'razorpay_modal';
  keyId: string;
  subscriptionId?: string;
  orderId?: string;
  amountMinor: number;
  currency: 'INR';
  description: string;
  prefill: { email?: string; name?: string };
  notes: Record<string, string>;
};

type RazorpayOptions = {
  key: string;
  amount?: number;
  currency: string;
  name: string;
  description?: string;
  subscription_id?: string;
  order_id?: string;
  prefill?: { email?: string; name?: string };
  notes?: Record<string, string>;
  handler?: (resp: { razorpay_payment_id: string }) => void;
  modal?: { ondismiss?: () => void };
  theme?: { color?: string };
};

type RazorpayInstance = { open: () => void };
type RazorpayConstructor = new (opts: RazorpayOptions) => RazorpayInstance;
declare global {
  interface Window { Razorpay?: RazorpayConstructor }
}

const SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
let scriptPromise: Promise<void> | null = null;

function loadRazorpayScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'));
  if (window.Razorpay) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { scriptPromise = null; reject(new Error('Failed to load Razorpay script')); };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export async function openRazorpayModal(
  handoff: RazorpayHandoff,
  callbacks: { onSuccess?: () => void; onDismiss?: () => void } = {},
): Promise<void> {
  await loadRazorpayScript();
  const Razorpay = window.Razorpay!;
  const rzp = new Razorpay({
    key: handoff.keyId,
    amount: handoff.amountMinor,
    currency: handoff.currency,
    name: 'Sociafy',
    description: handoff.description,
    subscription_id: handoff.subscriptionId,
    order_id: handoff.orderId,
    prefill: handoff.prefill,
    notes: handoff.notes,
    handler: () => {
      callbacks.onSuccess?.();
      // Same return URL pattern as Stripe.
      window.location.href = '/billing?checkout=success';
    },
    modal: { ondismiss: () => callbacks.onDismiss?.() },
    theme: { color: '#ff6b35' },
  });
  rzp.open();
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/billing/razorpay-checkout.tsx
git commit -m "feat(billing): add Razorpay checkout modal launcher"
```

---

### Task 27: Update `/billing` page — currency banner + change-tier CTAs

**Files:**
- Modify: `app/billing/page.tsx`

- [ ] **Step 1: Update the `BillingPayload` type**

Replace the existing `type BillingPayload` block at the top of `app/billing/page.tsx`:

```ts
type BillingPayload = {
  currentTier: 'starter' | 'pro' | 'business';
  currentTierLabel: string;
  monthlyAllocation: number;
  balance: number;
  subscriptionStatus: string | null;
  subscriptionCurrentPeriodEnd: string | null;
  stripeCustomerId: string | null;
  razorpayCustomerId: string | null;
  hasActiveSubscription: boolean;
  billingConfigured: boolean;
  currency: 'INR' | 'USD';
  provider: 'razorpay' | 'stripe' | null;
  isIndia: boolean;
  canSwitchProvider: boolean;
  pendingTierChange: { toTier: 'starter' | 'pro' | 'business'; at: string | null } | null;
  tiers: Array<{
    tier: 'starter' | 'pro' | 'business';
    label: string;
    priceMonthly: string;
    amountMinor: number;
    credits: number;
    isCurrent: boolean;
  }>;
};
```

- [ ] **Step 2: Add handoff dispatcher import**

Near the top of the file, add:

```ts
import { openRazorpayModal } from '../../components/billing/razorpay-checkout';

type CheckoutHandoff =
  | { kind: 'redirect'; url: string }
  | {
      kind: 'razorpay_modal';
      keyId: string;
      subscriptionId?: string;
      orderId?: string;
      amountMinor: number;
      currency: 'INR';
      description: string;
      prefill: { email?: string; name?: string };
      notes: Record<string, string>;
    };

const TIER_RANK: Record<BillingPayload['currentTier'], number> = { starter: 0, pro: 1, business: 2 };
```

- [ ] **Step 3: Rewrite `startCheckout` to dispatch on handoff kind**

Replace the existing `startCheckout` function with:

```ts
  const dispatchHandoff = async (handoff: CheckoutHandoff) => {
    if (handoff.kind === 'redirect') {
      window.location.href = handoff.url;
      return;
    }
    await openRazorpayModal(handoff, {
      onDismiss: () => setToast('Checkout canceled — no changes to your plan.'),
    });
  };

  const startCheckout = async (tier: 'starter' | 'pro' | 'business') => {
    setBusy(tier);
    try {
      const handoff = await apiPost<CheckoutHandoff>('/api/billing/checkout', { tier });
      await dispatchHandoff(handoff);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('503')) {
        setToast('Billing isn\'t configured yet — Razorpay keys missing in .env.local.');
      } else {
        setToast(`Checkout failed: ${msg.slice(0, 160)}`);
      }
    } finally {
      setBusy(null);
    }
  };

  const changeTier = async (toTier: 'starter' | 'pro' | 'business') => {
    setBusy(toTier);
    try {
      const result = await apiPost<{ kind: 'immediate' | 'scheduled'; effectiveAt: string; handoff?: CheckoutHandoff }>(
        '/api/billing/change-tier',
        { toTier },
      );
      if (result.kind === 'immediate' && result.handoff) {
        await dispatchHandoff(result.handoff);
      } else if (result.kind === 'scheduled') {
        setToast(`Plan will switch to ${toTier} on ${new Date(result.effectiveAt).toLocaleDateString()}.`);
        await mutate();
      } else {
        setToast('Plan switched.');
        await mutate();
      }
    } catch (e) {
      setToast(`Couldn't switch tier: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    } finally {
      setBusy(null);
    }
  };
```

- [ ] **Step 4: Replace the tier-grid card button to choose upgrade/downgrade/checkout**

Inside the `.billing-tier-grid` map, replace the existing button block:

```tsx
                    {t.isCurrent ? (
                      <button className="btn" disabled style={{ width: '100%', justifyContent: 'center' }}>
                        <Icon name="check" size={12} /> Current plan
                      </button>
                    ) : data?.currency === 'USD' ? (
                      <button className="btn" disabled style={{ width: '100%', justifyContent: 'center' }}>
                        USD billing coming soon
                      </button>
                    ) : data?.hasActiveSubscription ? (
                      <button
                        className="btn primary"
                        style={{ width: '100%', justifyContent: 'center' }}
                        onClick={() => changeTier(t.tier)}
                        disabled={busy === t.tier}
                      >
                        {busy === t.tier ? 'Working…' :
                          TIER_RANK[t.tier] > TIER_RANK[data!.currentTier]
                            ? `Upgrade to ${t.label}`
                            : `Downgrade to ${t.label}`}
                      </button>
                    ) : (
                      <button
                        className="btn primary"
                        style={{ width: '100%', justifyContent: 'center' }}
                        onClick={() => startCheckout(t.tier)}
                        disabled={busy === t.tier}
                      >
                        {busy === t.tier ? 'Redirecting…' : `Subscribe to ${t.label}`}
                      </button>
                    )}
```

- [ ] **Step 5: Add the currency banner above the tier grid**

Just before the `<section className="billing-tiers">` block, insert:

```tsx
          {data && data.canSwitchProvider && (
            <div className="billing-currency-banner" style={{
              padding: '10px 14px',
              background: 'var(--accent-soft)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              marginBottom: 16,
              fontSize: 13,
            }}>
              {data.currency === 'INR' ? (
                <>Pay in <strong>₹ INR via Razorpay</strong>. USD billing coming soon.</>
              ) : (
                <>USD billing via Stripe — <em>coming soon</em>.{' '}
                  <button
                    className="btn ghost"
                    style={{ marginLeft: 8 }}
                    onClick={async () => {
                      try {
                        await apiPost('/api/billing/preferences', { currency: 'INR' });
                        await mutate();
                      } catch (e) {
                        setToast(`Couldn't switch currency: ${e instanceof Error ? e.message : String(e)}`);
                      }
                    }}
                  >Pay in ₹ INR via Razorpay instead</button>
                </>
              )}
            </div>
          )}
          {data && !data.canSwitchProvider && (
            <div className="billing-currency-banner" style={{
              padding: '10px 14px',
              background: 'transparent',
              borderRadius: 10,
              marginBottom: 16,
              fontSize: 12,
              color: 'var(--muted)',
            }}>
              Billing in <strong>{data.currency === 'INR' ? '₹ INR via Razorpay' : '$ USD via Stripe'}</strong> · cancel to change
            </div>
          )}
```

- [ ] **Step 6: Update the configured-banner copy to mention Razorpay**

Replace the existing `!data.billingConfigured` banner copy:

```tsx
          {data && !data.billingConfigured && (
            <div className="insufficient-credits-banner" style={{ background: '#fff8eb', borderColor: '#f0d68a' }}>
              <div className="icon" style={{ background: '#fbe9c8', color: '#6b4408' }}>!</div>
              <div className="copy">
                <strong>Razorpay isn&apos;t configured yet.</strong>
                <span className="muted"> Add RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, and the three RAZORPAY_PLAN_* env vars to .env.local. Until then, upgrades just show this page.</span>
              </div>
            </div>
          )}
```

- [ ] **Step 7: Type-check + lint + dev server smoke check**

```bash
npx tsc --noEmit && npm run lint
```

Then start dev and load `/billing` to confirm no runtime errors (Razorpay not configured = banner shows, no crashes):

```bash
npm run dev
```

Visit http://localhost:3000/billing. Expected: page renders, banner visible, buttons present.

- [ ] **Step 8: Commit**

```bash
git add app/billing/page.tsx
git commit -m "feat(billing): currency banner + change-tier CTAs + Razorpay modal dispatch"
```

---

### Task 28: Top-up modal

**Files:**
- Modify: `app/billing/page.tsx`

- [ ] **Step 1: Add top-up state and handler**

In `BillingPageInner`, near the existing `const [busy, setBusy]` declarations, add:

```ts
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupBusy, setTopupBusy] = useState(false);

  const buyTopUp = async (credits: number) => {
    setTopupBusy(true);
    try {
      const handoff = await apiPost<CheckoutHandoff>('/api/billing/topup', { credits });
      setTopupOpen(false);
      await dispatchHandoff(handoff);
    } catch (e) {
      setToast(`Top-up failed: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    } finally {
      setTopupBusy(false);
    }
  };
```

- [ ] **Step 2: Add the "Top up" button next to the balance**

Inside `<section className="billing-current">`, after the `<div className="billing-balance-row">` block, add:

```tsx
              <div style={{ marginTop: 12 }}>
                <button className="btn" onClick={() => setTopupOpen(true)} disabled={!data?.hasActiveSubscription}>
                  <span aria-hidden style={{ marginRight: 4 }}>+</span> Top up credits
                </button>
                {!data?.hasActiveSubscription && (
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>Subscribe first to enable top-ups.</span>
                )}
              </div>
```

- [ ] **Step 3: Add the modal at the bottom of `BillingPageInner` return**

Just before the closing `</div>` of the `<div className="app">` wrapper, add:

```tsx
      {topupOpen && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setTopupOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--surface)', borderRadius: 12, padding: 20,
              width: 'min(420px, 92vw)', boxShadow: '0 20px 60px rgba(0,0,0,.3)',
            }}
          >
            <h3 style={{ marginTop: 0 }}>Top up credits</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              {data?.currency === 'INR' ? '₹1,499' : '$15'} per 1,000 credits. Charged once.
            </p>
            <div style={{ display: 'grid', gap: 8 }}>
              {[1000, 2000, 5000].map((n) => (
                <button
                  key={n}
                  className="btn primary"
                  style={{ justifyContent: 'space-between' }}
                  onClick={() => buyTopUp(n)}
                  disabled={topupBusy}
                >
                  <span>{n.toLocaleString()} credits</span>
                  <span className="mono">{data?.currency === 'INR' ? `₹${(1499 * (n / 1000)).toLocaleString()}` : `$${15 * (n / 1000)}`}</span>
                </button>
              ))}
            </div>
            <button className="btn ghost" style={{ marginTop: 12, width: '100%' }} onClick={() => setTopupOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
```

- [ ] **Step 4: Type-check + lint + visual smoke**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no errors. Load /billing in the browser, click "Top up credits" → modal opens, three buttons visible, "Cancel" closes the modal.

- [ ] **Step 5: Commit**

```bash
git add app/billing/page.tsx
git commit -m "feat(billing): add top-up modal with three credit packs"
```

---

### Task 29: Cancel button + pending-downgrade banner

**Files:**
- Modify: `app/billing/page.tsx`

- [ ] **Step 1: Add cancel handler**

Inside `BillingPageInner`, add:

```ts
  const [cancelBusy, setCancelBusy] = useState(false);

  const cancelSubscription = async () => {
    if (!confirm('Cancel your subscription? Credits stay usable until your renewal date.')) return;
    setCancelBusy(true);
    try {
      const r = await apiPost<{ periodEnd: string | null }>('/api/billing/cancel', {});
      const end = r.periodEnd ? new Date(r.periodEnd).toLocaleDateString() : 'your renewal date';
      setToast(`Subscription will end on ${end}.`);
      await mutate();
    } catch (e) {
      setToast(`Couldn't cancel: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    } finally {
      setCancelBusy(false);
    }
  };

  const clearPendingDowngrade = async () => {
    setBusy('clear-pending');
    try {
      const r = await apiFetch<{ cleared: boolean; caveat: string }>('/api/billing/change-tier', { method: 'DELETE' });
      setToast(r.caveat);
      await mutate();
    } catch (e) {
      setToast(`Couldn't clear pending switch: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    } finally {
      setBusy(null);
    }
  };
```

If `apiFetch` is not exported from `lib/ui/fetcher`, add it inline as:

```ts
  async function apiFetch<T>(url: string, init: RequestInit): Promise<T> {
    const r = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json() as Promise<T>;
  }
```

- [ ] **Step 2: Add the cancel button in the current-plan section**

Inside `<section className="billing-current">`, after the existing perks block, add:

```tsx
              {data?.hasActiveSubscription && (
                <div style={{ marginTop: 12 }}>
                  <button className="btn ghost" onClick={cancelSubscription} disabled={cancelBusy}>
                    {cancelBusy ? 'Canceling…' : 'Cancel subscription'}
                  </button>
                </div>
              )}
```

- [ ] **Step 3: Add the pending-downgrade banner above the tier grid**

Just before the `<section className="billing-tiers">`, add:

```tsx
          {data?.pendingTierChange && (
            <div className="insufficient-credits-banner" style={{ background: '#eef6ff', borderColor: '#bcd4f0' }}>
              <div className="icon" style={{ background: '#cfe3fb', color: '#264b7a' }}>i</div>
              <div className="copy" style={{ flex: 1 }}>
                <strong>Switches to {data.pendingTierChange.toTier} on {data.pendingTierChange.at ? new Date(data.pendingTierChange.at).toLocaleDateString() : 'cycle end'}.</strong>
                <span className="muted"> Credits from your current tier remain usable until then.</span>
              </div>
              <button className="btn ghost" onClick={clearPendingDowngrade} disabled={busy === 'clear-pending'}>
                {busy === 'clear-pending' ? '…' : 'Cancel switch'}
              </button>
            </div>
          )}
```

- [ ] **Step 4: Type-check + lint + visual smoke**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no errors. Load `/billing` and confirm: active-sub UI shows a "Cancel subscription" button; pending-downgrade row only renders when the API returns one.

- [ ] **Step 5: Commit**

```bash
git add app/billing/page.tsx
git commit -m "feat(billing): cancel button + pending-downgrade banner"
```

---

## Phase 9 — Docs + verification

### Task 30: Razorpay dashboard setup doc

**Files:**
- Create: `docs/billing-setup-razorpay.md`

- [ ] **Step 1: Write the setup doc**

```markdown
# Razorpay Setup — One-time

1. **Create three Plans** in Razorpay Dashboard → Subscriptions → Plans:
   - "Sociafy Starter (INR)" · ₹2,999 · Monthly · 30 days.
   - "Sociafy Pro (INR)" · ₹7,999 · Monthly · 30 days.
   - "Sociafy Business (INR)" · ₹29,999 · Monthly · 30 days.

   Copy each plan's `plan_id` (looks like `plan_OabcXyz`) into:
   - `RAZORPAY_PLAN_STARTER`
   - `RAZORPAY_PLAN_PRO`
   - `RAZORPAY_PLAN_BUSINESS`

2. **Webhook endpoint**: Settings → Webhooks → Add new endpoint.
   - URL: `https://<your-host>/api/razorpay/webhook`
   - Active events:
     - `subscription.activated`
     - `subscription.charged`
     - `subscription.updated`
     - `subscription.cancelled`
     - `subscription.completed`
     - `subscription.halted`
     - `subscription.paused`
     - `payment.captured`
   - Generate a secret → copy into `RAZORPAY_WEBHOOK_SECRET`.

3. **API keys**: Settings → API Keys → Generate.
   - Copy `key_id` into both `RAZORPAY_KEY_ID` and `NEXT_PUBLIC_RAZORPAY_KEY_ID`.
   - Copy `key_secret` into `RAZORPAY_KEY_SECRET`.

4. **Test mode first**: do steps 1–3 in Test Mode. Use test cards from
   [razorpay.com/docs/payments/payments/test-card-details](https://razorpay.com/docs/payments/payments/test-card-details)
   to verify the whole flow. Flip to Live Mode keys once the manual test
   matrix (`docs/superpowers/specs/2026-05-22-razorpay-billing-provider-design.md`
   §15) passes end-to-end.

5. **Local dev**: set `DEV_FORCE_COUNTRY=IN` in `.env.local` so the
   country detector returns India without needing a Vercel deployment.
```

- [ ] **Step 2: Commit**

```bash
git add docs/billing-setup-razorpay.md
git commit -m "docs: add Razorpay dashboard setup guide"
```

---

### Task 31: Run the manual test matrix (verification only — no code changes)

**Files:** none — this is a verification gate.

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Build to catch type errors that escaped per-file checks**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Execute the spec §15 manual matrix in Razorpay Test Mode**

Set test-mode env vars and run `npm run dev`. Walk through each row:

1. New Indian visitor → `/billing` shows INR pricing, Razorpay CTA.
2. New non-Indian visitor → `/billing` shows USD coming soon, INR opt-in link visible.
3. Indian user clicks "Subscribe to Pro" → Razorpay modal opens → complete mandate with test card → return URL `/billing?checkout=success` → balance shows 6,000 within ~10s of the webhook.
4. Pro user clicks "Upgrade to Business" → diff modal → pay → return → balance shows ~25,000 (6,000 + delta).
5. Business user clicks "Downgrade to Pro" → banner shows pending change.
6. Replay `subscription.completed` from Razorpay dashboard for the test sub → new Pro sub created, credits grant.
7. Cancel subscription → banner appears, credits remain, no renewal happens.
8. Re-deliver any `payment.captured` from the dashboard → no extra ledger row appears (verify in Supabase: `SELECT count(*) FROM credit_ledger WHERE meta->>'source' = 'rzp_topup:<id>'` returns 1).
9. Top-up 1,000 credits → modal → return → balance +1,000.
10. Stripe webhook regression: trigger a Stripe test webhook (any historical event) — confirm it still parses and produces the same DB outcome as before this refactor.

- [ ] **Step 4: If any row fails, file as a bug and fix before declaring done**

Each failed row is its own follow-up commit. No bundling.

- [ ] **Step 5: Once all rows pass, tag the release**

```bash
git tag -a v0.razorpay -m "Razorpay billing provider — Phase 1 shipped"
git push origin v0.razorpay
```

---

## End of Plan
