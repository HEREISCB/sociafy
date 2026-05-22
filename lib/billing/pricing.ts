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
