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
