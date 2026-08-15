/**
 * Geo → currency for GET /api/billing.
 *
 * Was an audit artifact for two bugs, now the regression test for their fix:
 *   1. Production is Cloudflare -> nginx -> Next (etc/nginx/sites-available/sociafy.conf),
 *      which forwards `CF-IPCountry`. The route only read `x-vercel-ip-country`,
 *      which nothing sets, so every Indian customer was quoted in USD.
 *   2. It then wrote that client-supplied header through to `billing_country`
 *      permanently. The header is display-only now and is never persisted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { profileRow, updates } = vi.hoisted(() => ({
  profileRow: {
    id: 'u1',
    tier: 'starter',
    billingCountry: null as string | null,
    billingCurrency: null as string | null,
    subscriptionStatus: null as string | null,
    subscriptionCurrentPeriodEnd: null,
    stripeCustomerId: null,
    razorpayCustomerId: null,
    pendingTierChangeTo: null,
    pendingTierChangeAt: null,
  },
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../lib/api', () => ({
  withUser: async (h: (u: { id: string }) => unknown) => {
    const r = await h({ id: 'u1' });
    return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
  },
}));
vi.mock('../../../lib/db', () => ({
  db: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([profileRow]) }) }) }),
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: () => { updates.push(v); return Promise.resolve(); } }) }),
  }),
}));
vi.mock('../../../lib/credits/ledger', () => ({ getBalance: async () => 0 }));
// geoCountry is the thing under test, so it comes from the real module; only the
// credential-shaped exports are stubbed.
vi.mock('../../../lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/env')>()),
  env: { razorpay: { planStarter: 'p1', planPro: 'p2', planBusiness: 'p3' } },
  isStubMode: { razorpay: () => false },
}));
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));

import { GET } from './route';

const call = (headers: Record<string, string>) =>
  GET(new Request('https://sociafy.app/api/billing', { headers }) as never);

describe('GET /api/billing — geo currency', () => {
  beforeEach(() => {
    profileRow.billingCountry = null;
    profileRow.billingCurrency = null;
    updates.length = 0;
  });

  it('quotes an Indian visitor behind Cloudflare in rupees', async () => {
    const body = await (await call({ 'cf-ipcountry': 'IN' })).json();
    expect(body.isIndia).toBe(true);
    expect(body.currency).toBe('INR');
    expect(body.tiers[0].priceMonthly).toBe('₹2,999');
    expect(body.tiers[0].priceApproximate).toBe(false);
  });

  it('quotes a non-India visitor an approximation, still charged in ₹', async () => {
    const body = await (await call({ 'cf-ipcountry': 'US' })).json();
    expect(body.isIndia).toBe(false);
    expect(body.currency).toBe('USD');
    expect(body.tiers[0].priceMonthly).toMatch(/^≈\$/);
    // The approximation must always be shown next to the real charge.
    expect(body.tiers[0].chargeMonthly).toBe('₹2,999');
  });

  it('still honours x-vercel-ip-country when there is no CF header (preview deploys)', async () => {
    const body = await (await call({ 'x-vercel-ip-country': 'IN' })).json();
    expect(body.isIndia).toBe(true);
    expect(body.currency).toBe('INR');
  });

  it('prefers CF-IPCountry over the Vercel header', async () => {
    const body = await (await call({ 'cf-ipcountry': 'IN', 'x-vercel-ip-country': 'US' })).json();
    expect(body.currency).toBe('INR');
  });

  it('treats Cloudflare\'s XX / T1 as "unknown", not as a country', async () => {
    for (const cc of ['XX', 'T1']) {
      const body = await (await call({ 'cf-ipcountry': cc })).json();
      expect(body.isIndia).toBe(false);
    }
  });

  it('never persists the header — it is client-supplied on this stack', async () => {
    await call({ 'cf-ipcountry': 'IN' });
    await call({ 'x-vercel-ip-country': 'IN' });
    expect(updates).toEqual([]);
    expect(profileRow.billingCountry).toBe(null);
  });

  it('lets a stored billingCurrency override the header', async () => {
    profileRow.billingCurrency = 'USD';
    const body = await (await call({ 'cf-ipcountry': 'IN' })).json();
    expect(body.currency).toBe('USD');
  });
});
