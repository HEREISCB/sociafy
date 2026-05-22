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
