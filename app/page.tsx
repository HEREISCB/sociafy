import { headers } from 'next/headers';
import LandingPage from '../components/landing';
import { devForcedCountry } from '../lib/env';
import type { Currency } from '../lib/billing/pricing';

/**
 * Server shell for the marketing page. Its only job is to resolve the visitor's
 * currency from the geo header BEFORE the HTML is built, so an India visitor's
 * first paint is already in rupees.
 *
 * This is why the page is dynamic rather than prerendered: a static page has no
 * request to read, so the currency could only be corrected after mount — which
 * shows dollar prices first and repaints them. The cost is one uncached render
 * of a page with no data fetching; the alternative is a visible price flicker
 * on the highest-intent screen we have.
 *
 * Same country signal as /api/billing (x-vercel-ip-country → DEV_FORCE_COUNTRY),
 * so the landing price and the checkout price can't disagree. Null when the host
 * doesn't geolocate — the client then guesses from timezone.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  const country = (await headers()).get('x-vercel-ip-country')?.toUpperCase() ?? devForcedCountry();
  const initialCurrency: Currency | null = country ? (country === 'IN' ? 'INR' : 'USD') : null;
  return <LandingPage initialCurrency={initialCurrency} />;
}
