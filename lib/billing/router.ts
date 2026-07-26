/**
 * Selects the BillingProvider for a profile. Lock-first: once
 * `payment_provider` is set on the profile (i.e. user has started a
 * subscription), that wins. Otherwise it used to derive from billing
 * currency, then from country.
 *
 * Stripe is parked: every customer is charged by Razorpay in INR regardless
 * of location, so every branch below resolves to Razorpay. The Stripe
 * provider stays in the tree — dormant and unrouted — for the day USD
 * billing is switched on. Stripe never charged anyone, so no profile can
 * legitimately carry a `stripe` lock; a stray value routes to Razorpay
 * rather than dead-ending the customer's checkout.
 *
 * Returns null only when Razorpay credentials are missing — callers turn
 * that into a 503 rather than a mid-checkout crash.
 */

import type { BillingProvider } from './provider';
import { razorpayProvider } from './providers/razorpay';
import { isStubMode } from '../env';

export type ProfileForRouting = {
  paymentProvider: 'stripe' | 'razorpay' | null;
  billingCurrency: 'INR' | 'USD' | null;
  billingCountry: string | null;
};

const razorpayOrNull = () => (isStubMode.razorpay() ? null : razorpayProvider());

export function providerFor(profile: ProfileForRouting): BillingProvider | null {
  const locked = profile.paymentProvider;
  if (locked === 'razorpay') return razorpayOrNull();
  if (locked === 'stripe')   return razorpayOrNull(); // parked — see above

  // `billingCurrency` / `billingCountry` no longer branch here: they only
  // decide how the price is *displayed* (see pricing.ts). Un-parking Stripe
  // means restoring the derive-from-currency step at this point.
  return razorpayOrNull();
}
