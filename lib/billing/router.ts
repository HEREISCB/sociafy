/**
 * Selects the BillingProvider for a profile. Lock-first: once
 * `payment_provider` is set on the profile (i.e. user has started a
 * subscription), that wins. Otherwise derive from billing currency, then
 * from country.
 *
 * Returns null only when the resolved provider has no usable credentials —
 * callers turn that into a 503 rather than a mid-checkout crash.
 */

import type { BillingProvider } from './provider';
import { razorpayProvider } from './providers/razorpay';
import { stripeProvider, stripeConfigured } from './providers/stripe';

const stripeOrNull = () => (stripeConfigured() ? stripeProvider() : null);

export type ProfileForRouting = {
  paymentProvider: 'stripe' | 'razorpay' | null;
  billingCurrency: 'INR' | 'USD' | null;
  billingCountry: string | null;
};

export function providerFor(profile: ProfileForRouting): BillingProvider | null {
  const locked = profile.paymentProvider;
  if (locked === 'razorpay') return razorpayProvider();
  if (locked === 'stripe')   return stripeOrNull();

  const currency = profile.billingCurrency
    ?? (profile.billingCountry === 'IN' ? 'INR' : 'USD');
  return currency === 'INR' ? razorpayProvider() : stripeOrNull();
}
