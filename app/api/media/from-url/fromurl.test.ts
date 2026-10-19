import { describe, it, expect, beforeEach, vi } from 'vitest';

/** POST /api/media/from-url: read the site through the SSRF-guarded fetcher, charge 1 cr, one LLM call → products. */
const st = vi.hoisted(() => ({
  /** null = the site is down. */
  pages: {} as Record<string, string | null>,
  fetched: [] as string[],
  completion: '' as string | Error,
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  balance: 100,
}));

vi.mock('../../../../lib/api', () => ({
  withUser: (handler: (u: { id: string }) => unknown) => Promise.resolve(handler({ id: 'user_1' })),
  jsonError: (error: string, status = 400, extra?: Record<string, unknown>) => ({ error, status, ...extra }),
}));
vi.mock('../../../../lib/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('../../../../lib/ai/client', () => ({
  getTextAI: () => ({ kind: 'openai', model: 'test' }),
  completeText: async (_ai: unknown, opts: Record<string, unknown>) => {
    st.calls.push({ fn: 'llm', args: opts });
    if (st.completion instanceof Error) throw st.completion;
    return st.completion;
  },
}));
// Known pages are served from memory; anything else goes through the REAL fetchPage, so the SSRF guard is the one under test.
vi.mock('../../../../lib/ai/skills/fetch-url', async (orig) => {
  const real = await orig<typeof import('../../../../lib/ai/skills/fetch-url')>();
  return {
    ...real,
    fetchPage: async (url: string) => {
      st.fetched.push(url);
      // The public-reader fallback never leaves the test process.
      const html = url.startsWith('https://r.jina.ai/') ? null : st.pages[url];
      if (html === null) return { error: 'fetch_failed' };
      return html === undefined ? real.fetchPage(url) : { url, contentType: 'text/html', bytes: html.length, html };
    },
  };
});
vi.mock('../../../../lib/credits/ledger', () => {
  class InsufficientCreditsError extends Error { constructor(readonly balance: number, readonly needed: number) { super('insufficient'); } }
  return {
    InsufficientCreditsError,
    insufficientCreditsResponse: (a: { balance: number; needed: number }) => ({ status: 402, error: 'insufficient_credits', ...a }),
    charge: async (args: Record<string, unknown>) => {
      st.calls.push({ fn: 'charge', args });
      if (st.balance < (args.credits as number)) throw new InsufficientCreditsError(st.balance, args.credits as number);
      return { ledgerId: 'led_1', balanceAfter: st.balance - (args.credits as number) };
    },
    refund: async (args: Record<string, unknown>) => { st.calls.push({ fn: 'refund', args }); return { refunded: true, balanceAfter: st.balance }; },
  };
});

import { POST } from './route';
import { pageImages } from '../../../../lib/ai/site-products';

const HOME = `<html><head><title>Brew Co</title>
<meta property="og:image" content="https://cdn.brew.co/og.jpg"></head><body>
<nav><a href="/shop">Shop</a><a href="/about">About</a></nav>
<h1>Brew Co — coffee gear</h1><p>Cold brew bottle ₹199. Pour-over kettle ₹1,499 with gooseneck spout.</p>
<img src="/img/bottle.jpg" alt="Cold brew bottle"><img src="https://cdn.brew.co/logo.png" alt="Brew Co">
<img src="data:image/gif;base64,AAAA" data-src="https://cdn.brew.co/kettle.webp" alt="Kettle">
<img src="http://insecure.brew.co/x.jpg"></body></html>`;
const SHOP = '<html><body><h2>All products</h2><p>Bottle, kettle.</p></body></html>';

const post = (body: unknown) =>
  POST(new Request('http://x/api/media/from-url', { method: 'POST', body: JSON.stringify(body) }) as never) as unknown as Promise<Record<string, unknown>>;
const fns = () => st.calls.map((c) => c.fn);

beforeEach(() => {
  st.pages = { 'https://brew.co': HOME, 'https://brew.co/': HOME, 'https://brew.co/shop': SHOP, 'https://brew.co/about': SHOP, 'https://down.example/': null };
  st.fetched = []; st.calls = []; st.balance = 100;
  st.completion = JSON.stringify({
    site: { name: 'Brew Co', summary: 'Coffee gear.' },
    products: [
      { name: 'Cold brew bottle', pitch: 'A bottle for cold brew.', facts: ['₹199'], images: [1, 99, 1], postText: 'Cold brew, ₹199. Order today.' },
      { name: 'Pour-over kettle', pitch: 'Gooseneck kettle.', facts: ['₹1,499', 'gooseneck spout'], images: [2], postText: 'Pour like a barista. ₹1,499.' },
    ],
  });
});

describe('pageImages', () => {
  it('og:image first, relative and lazy srcs resolved; http, data:, logos dropped', () => {
    expect(pageImages(HOME, 'https://brew.co/').map((i) => i.url)).toEqual([
      'https://cdn.brew.co/og.jpg', 'https://brew.co/img/bottle.jpg', 'https://cdn.brew.co/kettle.webp',
    ]);
  });
});

describe('POST /api/media/from-url', () => {
  it('splits a multi-product site: one charge of 1 cr, image indexes mapped to found URLs only', async () => {
    const r = await post({ url: 'brew.co' });
    expect(st.fetched).toEqual(['https://brew.co', 'https://brew.co/shop']);
    expect(r).toMatchObject({
      site: { name: 'Brew Co' },
      creditsCharged: 1,
      products: [
        { id: 'p1', name: 'Cold brew bottle', imageUrls: ['https://brew.co/img/bottle.jpg'], postText: 'Cold brew, ₹199. Order today.' },
        { id: 'p2', name: 'Pour-over kettle', facts: ['₹1,499', 'gooseneck spout'], imageUrls: ['https://cdn.brew.co/kettle.webp'] },
      ],
    });
    expect(fns()).toEqual(['charge', 'llm']);
    expect(st.calls[0].args).toMatchObject({ userId: 'user_1', action: 'text_post', credits: 1 });
    // Page text is fenced as untrusted data.
    expect(st.calls[1].args.user).toMatch(/<page_text>[\s\S]*Cold brew bottle ₹199[\s\S]*<\/page_text>/);
  });

  it('refuses a private address via the real SSRF guard — nothing fetched upstream, nothing charged', async () => {
    expect(await post({ url: 'http://127.0.0.1/admin' })).toMatchObject({ status: 400, error: 'url_not_allowed', hint: expect.any(String) });
    expect(await post({ url: 'ftp://brew.co/' })).toMatchObject({ status: 400, error: 'invalid_url' });
    expect(fns()).toEqual([]);
  });

  it('an unreachable site is an honest 502 with nothing charged', async () => {
    expect(await post({ url: 'https://down.example/' })).toMatchObject({ status: 502, error: 'site_unreachable', hint: expect.stringMatching(/Nothing was charged/) });
    expect(fns()).toEqual([]);
  });

  it('unusable model output → refunded, 502 no_products_found', async () => {
    st.completion = '{"products": []}';
    expect(await post({ url: 'https://brew.co/' })).toMatchObject({ status: 502, error: 'no_products_found' });
    expect(fns()).toEqual(['charge', 'llm', 'refund']);
    expect(st.calls[2].args).toMatchObject({ ledgerId: 'led_1' });

    st.calls = []; st.completion = new Error('timeout');
    expect(await post({ url: 'https://brew.co/' })).toMatchObject({ status: 502, error: 'no_products_found' });
    expect(fns()).toEqual(['charge', 'llm', 'refund']);
  });

  it('no credits → 402 before the model runs', async () => {
    st.balance = 0;
    expect(await post({ url: 'https://brew.co/' })).toMatchObject({ status: 402, error: 'insufficient_credits', balance: 0, needed: 1 });
    expect(fns()).toEqual(['charge']);
  });

  it('caps captions at 600 chars and products at 8', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `P${i}`, postText: 'x'.repeat(900) }));
    st.completion = JSON.stringify({ site: {}, products: many });
    const r = await post({ url: 'https://brew.co/' }) as { products: { postText: string; imageUrls: string[] }[] };
    expect(r.products).toHaveLength(8);
    expect(r.products[0].postText).toHaveLength(600);
    expect(r.products[0].imageUrls).toEqual([]);
  });

  it('modes: whole website → one video and a site prompt; topics → a content prompt; unknown mode → 400', async () => {
    const site = await post({ url: 'https://brew.co/', mode: 'site' }) as { products: unknown[] };
    expect(site.products).toHaveLength(1);
    expect(String(st.calls.find((c) => c.fn === 'llm')!.args.system)).toMatch(/ONE social media video about the whole thing/);
    st.calls = [];
    await post({ url: 'https://brew.co/', mode: 'content' });
    expect(String(st.calls.find((c) => c.fn === 'llm')!.args.system)).toMatch(/topics worth a video each/);
    expect((await post({ url: 'https://brew.co/', mode: 'everything' })).status).toBe(400);
  });
});
