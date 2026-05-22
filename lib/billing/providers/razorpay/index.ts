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

  async changeTier(_args: { userId: string; toTier: Tier }): Promise<TierChangeResult> {
    throw new Error('not implemented in Task 13 — see Tasks 16-17');
  }
}

let _instance: RazorpayBillingProvider | null = null;
export function razorpayProvider(): RazorpayBillingProvider {
  if (!_instance) _instance = new RazorpayBillingProvider();
  return _instance;
}
