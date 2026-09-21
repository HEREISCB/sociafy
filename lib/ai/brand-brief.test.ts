/**
 * The brand brief reads a user-supplied URL server-side and feeds the result to
 * an LLM, so the things worth pinning are the boundaries: what text survives,
 * which links get followed, and that no failure ever reaches the caller (the
 * settings save).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  pages: {} as Record<string, string>,
  fetched: [] as string[],
  completion: 'A brief.',
}));

vi.mock('./client', () => ({
  getTextAI: () => ({ kind: 'openai', model: 'test' }),
  completeText: async () => state.completion,
}));
vi.mock('./skills/fetch-url', async (orig) => ({
  ...(await orig<typeof import('./skills/fetch-url')>()),
  fetchPage: async (url: string) => {
    state.fetched.push(url);
    const html = state.pages[url];
    return html === undefined ? { error: 'fetch_failed' } : { url, contentType: 'text/html', bytes: html.length, html };
  },
}));
vi.mock('../db', () => ({ db: () => ({}) }));

import { buildBrandBrief, pageText, pickExtraPages } from './brand-brief';
import { renderBrandBlock } from './brand-context';

const HOME = `<html><head><title>Acme &amp; Co</title>
<meta name="description" content="Rockets for coyotes">
<style>.x{color:red}</style></head><body>
<nav><a href="/about">About</a><a href="https://evil.example/pricing">Pricing</a></nav>
<script>alert('nope')</script><h1>Buy rockets</h1>
<a href="/pricing#plans">Plans</a><a href="/blog">Blog</a>
<footer>Copyright</footer></body></html>`;

beforeEach(() => {
  state.pages = {};
  state.fetched = [];
  state.completion = 'A brief.';
});

describe('pageText', () => {
  it('drops script/style/nav/footer and keeps title + description', () => {
    const text = pageText(HOME);
    expect(text).toContain('Title: Acme & Co');
    expect(text).toContain('Description: Rockets for coyotes');
    expect(text).toContain('Buy rockets');
    expect(text).not.toMatch(/alert|color:red|Copyright|About/);
  });
});

describe('pickExtraPages', () => {
  it('follows same-origin matches only, at most 2', () => {
    expect(pickExtraPages(HOME, 'https://acme.test/')).toEqual([
      'https://acme.test/about',
      'https://acme.test/pricing',
    ]);
  });
});

describe('buildBrandBrief', () => {
  it('never fetches an off-origin link', async () => {
    state.pages['https://acme.test/'] = HOME;
    expect(await buildBrandBrief('https://acme.test/')).toBe('A brief.');
    expect(state.fetched).toEqual(['https://acme.test/', 'https://acme.test/about', 'https://acme.test/pricing']);
  });

  it('returns null when the fetch fails', async () => {
    expect(await buildBrandBrief('https://down.test/')).toBeNull();
  });

  it('caps the brief at 1000 chars', async () => {
    state.pages['https://acme.test/'] = HOME;
    state.completion = 'x'.repeat(5000);
    expect(await buildBrandBrief('https://acme.test/')).toHaveLength(1000);
  });
});

describe('renderBrandBlock', () => {
  it('carries the brief right after the website, in both modes', () => {
    const ctx = {
      companyName: 'Acme', brandBio: null, website: 'https://acme.test', brandBrief: 'Sells rockets.',
      niches: [], voiceTemplate: null, instructions: null, brandSafetyStrict: false,
    };
    for (const mode of ['text', 'media'] as const) {
      expect(renderBrandBlock(ctx, mode)).toContain('Website: https://acme.test\nFrom their website: Sells rockets.');
    }
  });
});
