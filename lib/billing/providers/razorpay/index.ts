/**
 * Razorpay implementation of BillingProvider. Subscriptions use the
 * standard Subscriptions API; top-ups and upgrade-diff payments use
 * Orders. All flows return a `razorpay_modal` handoff the client opens
 * via Razorpay's Standard Checkout JS.
 */

import { eq } from 'drizzle-orm';
import type { Tier } from '../../../db/schema';
import { profiles } from '../../../db/schema';
import { db } from '../../../db';
import { TIER_PRICING, TOPUP_PRICING } from '../../pricing';
import type { BillingProvider, CheckoutHandoff, TierChangeResult } from '../../provider';
import { env } from '../../../env';
import { getRazorpay, razorpayPlanIdFor } from './client';
import { ensureRazorpayCustomer } from './customer';
import { proratedDiffMinor } from './proration';

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
      total_count: 120,
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
      // Cosmetic: these go through the browser into the Checkout constructor, so
      // they are attacker-controlled by construction. The webhook grants off the
      // ORDER's notes above — never these. Do not add anything load-bearing here.
      notes: { sociafy_user_id: userId, kind: 'topup', credits: String(credits) },
    };
  }

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
  }
}

let _instance: RazorpayBillingProvider | null = null;
export function razorpayProvider(): RazorpayBillingProvider {
  if (!_instance) _instance = new RazorpayBillingProvider();
  return _instance;
}
