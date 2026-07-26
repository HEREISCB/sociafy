/**
 * Currency-aware tier pricing. The tier IDs and credit allocations live in
 * `db/schema.ts` (TIERS, TIER_CREDITS); this module owns the display copy
 * and on-the-wire minor-unit amounts per currency.
 *
 * Every customer is charged by Razorpay in INR (see `router.ts`), so the INR
 * amounts are the single source of truth. A non-India visitor is shown an
 * approximation *derived from* the INR amount — never the separate USD price
 * point below, which is ~19% cheaper and would advertise one price while
 * billing another. UI reads `tierPriceView` / `topupPriceView`; the Razorpay
 * provider reads `TIER_PRICING.INR` / `TOPUP_PRICING.INR`.
 *
 * The USD entries stay because the parked Stripe provider still reads them.
 */

import type { Tier } from '../db/schema';

export type Currency = 'INR' | 'USD';

export const TIER_PRICING: Record<Currency, Record<Tier, {
  priceMonthly: string;
  amountMinor: number;
}>> = {
  // Parked: read only by lib/billing/providers/stripe, which nothing routes to.
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

/**
 * Display-only FX approximation — nothing is ever charged in USD. It drifts;
 * when it is more than a few percent stale, edit this one number and nothing
 * else. Deliberately set a little below the spot rate: a low rate yields a
 * slightly HIGH dollar figure, so the approximation never undersells the
 * rupee amount we actually take.
 */
export const INR_PER_USD = 83;

/** Paise → whole dollars. Rounded to read like a price, not a conversion. */
const usdFromPaise = (paise: number): number => Math.round(paise / 100 / INR_PER_USD);

const inrLabel = (paise: number): string => `₹${(paise / 100).toLocaleString('en-IN')}`;

export type PriceView = {
  /** Headline figure in the visitor's currency. Approximate unless INR. */
  display: string;
  /** What Razorpay actually charges. Always INR. */
  charge: string;
  chargeMinor: number;
  /** `display`'s whole-unit value, for per-credit maths. */
  displayMajor: number;
  /** True when `display` is derived — callers MUST also surface `charge`. */
  approximate: boolean;
};

export function tierPriceView(currency: Currency, tier: Tier): PriceView {
  const { priceMonthly, amountMinor } = TIER_PRICING.INR[tier];
  const approximate = currency !== 'INR';
  const major = approximate ? usdFromPaise(amountMinor) : amountMinor / 100;
  return {
    display: approximate ? `≈$${major.toLocaleString('en-US')}` : priceMonthly,
    charge: priceMonthly,
    chargeMinor: amountMinor,
    displayMajor: major,
    approximate,
  };
}

/** Same treatment for top-ups. `credits` must be a multiple of the pack size. */
export function topupPriceView(currency: Currency, credits = TOPUP_PRICING.INR.credits): PriceView & { credits: number } {
  const packs = credits / TOPUP_PRICING.INR.credits;
  const chargeMinor = TOPUP_PRICING.INR.amountMinor * packs;
  const approximate = currency !== 'INR';
  const major = approximate ? usdFromPaise(chargeMinor) : chargeMinor / 100;
  return {
    display: approximate ? `≈$${major.toLocaleString('en-US')}` : inrLabel(chargeMinor),
    charge: inrLabel(chargeMinor),
    chargeMinor,
    displayMajor: major,
    approximate,
    credits,
  };
}

/** "≈$18 / 1,000 credits" — the top-up line used in prose. */
export function topupLabel(currency: Currency, credits = TOPUP_PRICING.INR.credits): string {
  const v = topupPriceView(currency, credits);
  return `${v.display} / ${credits.toLocaleString('en-US')} credits`;
}
