import { NextRequest, NextResponse } from 'next/server';
import {
  fetchGoogleNews,
  fetchGoogleNewsControversy,
  fetchHackerNews,
  fetchWikipedia,
} from '../../../../../lib/demo/shield-sources';
import { scoreMention } from '../../../../../lib/demo/shield-sentiment';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const brand = String(body.brand ?? '').trim();

  if (!brand || brand.length < 2) {
    return NextResponse.json({ error: 'Brand name required (min 2 chars)' }, { status: 400 });
  }
  if (brand.length > 80) {
    return NextResponse.json({ error: 'Brand name too long' }, { status: 400 });
  }

  // Fetch all sources in parallel — all free, no API keys needed
  const [gnewsResult, gnewsNegResult, hnResult, wikiResult] = await Promise.allSettled([
    fetchGoogleNews(brand),
    fetchGoogleNewsControversy(brand),
    fetchHackerNews(brand),
    fetchWikipedia(brand),
  ]);

  const gnews    = gnewsResult.status    === 'fulfilled' ? gnewsResult.value    : [];
  const gnewsNeg = gnewsNegResult.status === 'fulfilled' ? gnewsNegResult.value : [];
  const hn       = hnResult.status       === 'fulfilled' ? hnResult.value       : [];
  const wiki     = wikiResult.status     === 'fulfilled' ? wikiResult.value     : [];

  // Merge all, de-duplicate by normalised title
  const all = [...gnews, ...gnewsNeg, ...hn, ...wiki];
  const seen = new Set<string>();
  const deduped = all.filter(m => {
    const key = m.title.toLowerCase().replace(/\W/g, '').slice(0, 60);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Score sentiment on each mention
  const scored = deduped
    .filter(m => m.title.trim().length > 5)
    .map(m => ({ ...m, sentiment: scoreMention(m.title, m.body) }));

  // Sort: crisis → negative → neutral → positive, then severity desc
  const order = { crisis: 0, negative: 1, neutral: 2, positive: 3 } as const;
  scored.sort((a, b) => {
    const diff = order[a.sentiment.label] - order[b.sentiment.label];
    if (diff !== 0) return diff;
    return b.sentiment.severity - a.sentiment.severity;
  });

  return NextResponse.json({
    mentions: scored,
    sources: {
      google_news: gnews.length + gnewsNeg.length,
      hackernews:  hn.length,
      wikipedia:   wiki.length,
    },
    total: scored.length,
    brand,
  });
}
