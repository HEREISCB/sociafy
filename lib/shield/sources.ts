/**
 * lib/shield/sources.ts
 *
 * Unified brand-mention fetchers.
 * Free sources (no auth): Google News RSS, Hacker News Algolia, Wikipedia.
 * OAuth sources: Reddit (requires connected account), X search (bearer token).
 *
 * All functions return RawMention[] and never throw — errors return [].
 */

import { searchRedditMentions, type RedditHit } from '../platforms/reddit';
import { searchTweets, isConfigured as twitterApiIoConfigured } from '../platforms/twitterapi-io';

const UA = 'Mozilla/5.0 (compatible; SociafyReputationShield/1.0)';

export type MentionSourceId = 'google_news' | 'hackernews' | 'wikipedia' | 'reddit' | 'x';

export interface RawMention {
  id: string;
  source: MentionSourceId;
  url: string;
  title: string;
  body: string;
  author: string;
  engagement: number;
  timestamp: number; // unix seconds
  platformPostId?: string; // native post ID for direct replies (tweet ID, reddit name, etc.)
}

// ── Google News RSS ───────────────────────────────────────────────────────────

export async function fetchGoogleNews(brand: string): Promise<RawMention[]> {
  const q = encodeURIComponent(`"${brand}"`);
  try {
    const res = await fetch(
      `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
      { headers: { 'User-Agent': UA }, cache: 'no-store' },
    );
    if (!res.ok) return [];
    return parseRSSItems(await res.text(), 'google_news');
  } catch { return []; }
}

export async function fetchGoogleNewsControversy(brand: string): Promise<RawMention[]> {
  const q = encodeURIComponent(
    `"${brand}" (controversy OR scandal OR lawsuit OR problem OR issue OR fail)`,
  );
  try {
    const res = await fetch(
      `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
      { headers: { 'User-Agent': UA }, cache: 'no-store' },
    );
    if (!res.ok) return [];
    return parseRSSItems(await res.text(), 'google_news');
  } catch { return []; }
}

function parseRSSItems(xml: string, source: MentionSourceId): RawMention[] {
  const blocks = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
  return blocks.slice(0, 40).map((block, i) => {
    const title = extractXML(block, 'title');
    const link  = extractXML(block, 'link');
    const desc  = extractXML(block, 'description');
    const pub   = extractXML(block, 'pubDate');
    const src   = extractXML(block, 'source') || 'news';
    return {
      id: `${source}-${i}-${hashStr(link || title)}`,
      source,
      url: link,
      title: cleanText(title),
      body: cleanText(desc).slice(0, 400),
      author: cleanText(src),
      engagement: 80 + i,
      timestamp: pub ? Date.parse(pub) / 1000 : Date.now() / 1000,
    };
  }).filter(m => m.title.length > 5);
}

// ── Hacker News (Algolia) ─────────────────────────────────────────────────────

export async function fetchHackerNews(brand: string): Promise<RawMention[]> {
  const q = encodeURIComponent(`"${brand}"`);
  try {
    const res = await fetch(
      `https://hn.algolia.com/api/v1/search?query=${q}&tags=story&hitsPerPage=30`,
      { headers: { 'User-Agent': UA }, cache: 'no-store' },
    );
    if (!res.ok) return [];
    const data = await res.json();
    const hits: any[] = data?.hits ?? [];
    return hits.map((h, i) => ({
      id: `hn-${h.objectID ?? i}`,
      source: 'hackernews' as const,
      url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
      title: h.title ?? '',
      body: (h.story_text ?? '').replace(/<[^>]*>/g, '').slice(0, 400),
      author: `HN / ${h.author ?? 'anon'}`,
      engagement: (h.points ?? 0) + (h.num_comments ?? 0) * 2,
      timestamp: h.created_at_i ?? Date.now() / 1000,
    })).filter(m => m.title.length > 5);
  } catch { return []; }
}

// ── Wikipedia ────────────────────────────────────────────────────────────────

export async function fetchWikipedia(brand: string): Promise<RawMention[]> {
  const [general, controversy] = await Promise.allSettled([
    wikiSearch(`${brand} controversy criticism scandal`),
    wikiSearch(`${brand} lawsuit investigation`),
  ]);
  const items = [
    ...(general.status === 'fulfilled' ? general.value : []),
    ...(controversy.status === 'fulfilled' ? controversy.value : []),
  ];
  const seen = new Set<string>();
  return items.filter(m => { if (seen.has(m.title)) return false; seen.add(m.title); return true; });
}

async function wikiSearch(query: string): Promise<RawMention[]> {
  const q = encodeURIComponent(query);
  try {
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&format=json&srlimit=8&srprop=snippet|titlesnippet|size`,
      { headers: { 'User-Agent': UA }, cache: 'no-store' },
    );
    if (!res.ok) return [];
    const data = await res.json();
    const results: any[] = data?.query?.search ?? [];
    return results.map((r, i) => ({
      id: `wiki-${r.pageid ?? i}`,
      source: 'wikipedia' as const,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
      title: r.title ?? '',
      body: cleanText(r.snippet ?? '').slice(0, 400),
      author: 'Wikipedia',
      engagement: Math.round(Math.max(50, (r.size ?? 0) / 100)),
      timestamp: Date.now() / 1000 - 86400,
    })).filter(m => m.title.length > 3);
  } catch { return []; }
}

// ── Reddit (OAuth) ────────────────────────────────────────────────────────────

export async function fetchRedditMentions(
  brand: string,
  accessToken: string,
): Promise<RawMention[]> {
  try {
    const hits: RedditHit[] = await searchRedditMentions(accessToken, brand, 25);
    return hits.map(h => ({
      id: `reddit-${h.name ?? h.id}`,
      source: 'reddit' as const,
      url: h.url ?? (h.permalink ? `https://www.reddit.com${h.permalink}` : ''),
      title: h.title ?? h.body?.slice(0, 100) ?? '',
      body: (h.selftext ?? h.body ?? '').slice(0, 400),
      author: `r/${h.subreddit ?? 'unknown'} · u/${h.author ?? 'anon'}`,
      engagement: (h.score ?? 0) + (h.num_comments ?? 0) * 2,
      timestamp: h.created_utc ?? Date.now() / 1000,
    })).filter(m => m.title.length > 5);
  } catch { return []; }
}

// ── X / Twitter search (TwitterAPI.io read API) ──────────────────────────────
// Reads go through TwitterAPI.io (pay-as-you-go, key-only) so we don't need an
// official X API subscription. Replies still post via official X OAuth.
// Provider-agnostic: swap the body for official /2/tweets/search/recent later
// without touching callers.

export function xReadsConfigured(): boolean {
  return twitterApiIoConfigured();
}

export async function fetchXMentions(
  brand: string,
  opts: { max?: number; query?: string } = {},
): Promise<RawMention[]> {
  if (!twitterApiIoConfigured()) return [];
  const max = opts.max ?? 20;
  // Use the smart resolved query when provided; else a literal phrase search.
  const query = opts.query ?? `"${brand}" lang:en -filter:retweets`;
  const tweets = await searchTweets(query, { queryType: 'Latest', max });
  return tweets
    .map(t => {
      const handle = t.author?.userName ? `@${t.author.userName}` : '@unknown';
      const likes = t.likeCount ?? 0;
      const rts = t.retweetCount ?? 0;
      const replies = t.replyCount ?? 0;
      return {
        id: `x-${t.id}`,
        source: 'x' as const,
        url: t.url || t.twitterUrl || `https://x.com/i/web/status/${t.id}`,
        title: (t.text ?? '').slice(0, 140),
        body: t.text ?? '',
        author: handle,
        engagement: likes + rts * 3 + replies * 2,
        timestamp: t.createdAt ? Date.parse(t.createdAt) / 1000 : Date.now() / 1000,
        platformPostId: t.id, // tweet ID for direct reply
      };
    })
    .filter(m => m.title.length > 5);
}

// ── All free sources bundled ──────────────────────────────────────────────────

export async function fetchAllFreeSources(brand: string): Promise<RawMention[]> {
  const [gnews, gnewsNeg, hn, wiki] = await Promise.allSettled([
    fetchGoogleNews(brand),
    fetchGoogleNewsControversy(brand),
    fetchHackerNews(brand),
    fetchWikipedia(brand),
  ]);
  return [
    ...(gnews.status === 'fulfilled' ? gnews.value : []),
    ...(gnewsNeg.status === 'fulfilled' ? gnewsNeg.value : []),
    ...(hn.status === 'fulfilled' ? hn.value : []),
    ...(wiki.status === 'fulfilled' ? wiki.value : []),
  ];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractXML(block: string, tag: string): string {
  const cdataRx = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const plainRx = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const cdata = block.match(cdataRx)?.[1];
  if (cdata) return cdata.trim();
  const plain = block.match(plainRx)?.[1];
  if (plain) return plain.trim();
  if (tag === 'link') {
    const inline = block.match(/<link\s*\/>|<link>(.*?)</)?.[1];
    return inline?.trim() ?? '';
  }
  return '';
}

function cleanText(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, '').trim();
}

function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
