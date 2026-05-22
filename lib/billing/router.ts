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
