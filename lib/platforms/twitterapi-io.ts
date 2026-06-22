/**
 * lib/platforms/twitterapi-io.ts
 *
 * Thin client for TwitterAPI.io — a third-party, pay-as-you-go X/Twitter READ
 * API. Used by the reputation shield to fetch brand mentions without an
 * official X API subscription (which gates search behind the $200/mo Basic
 * tier). Only the API key is needed — no OAuth, no proxy, no login.
 *
 * Posting/replying does NOT go through here; that uses official X OAuth
 * (lib/platforms/x.ts). This module is read-only by design.
 *
 * Docs: https://docs.twitterapi.io  ·  Auth: header `X-API-Key`.
 */

import { env } from '../env';

const BASE_URL = 'https://api.twitterapi.io';

/** Subset of the TwitterAPI.io tweet object we actually consume. The API
 *  returns many more fields; we keep this narrow and tolerant. */
export interface TwitterApiIoTweet {
  id: string;
  url?: string;
  twitterUrl?: string;
  text: string;
  retweetCount?: number;
  replyCount?: number;
  likeCount?: number;
  quoteCount?: number;
  viewCount?: number;
  bookmarkCount?: number;
  createdAt?: string; // e.g. "Mon Jun 22 04:59:53 +0000 2026"
  lang?: string;
  isReply?: boolean;
  inReplyToId?: string;
  conversationId?: string;
  author?: {
    userName?: string;
    name?: string;
    id?: string;
    isVerified?: boolean;
    isBlueVerified?: boolean;
    followers?: number;
  };
}

interface AdvancedSearchResponse {
  tweets?: TwitterApiIoTweet[];
  has_next_page?: boolean;
  next_cursor?: string;
}

export function isConfigured(): boolean {
  return !!env.twitterApiIo.apiKey;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Free-tier keys are capped at ~1 request / 5s (QPS). Serialize ALL calls
// process-wide behind a queue with a minimum gap, and retry once on 429.
// Override the gap via TWITTERAPI_IO_MIN_INTERVAL_MS (lower it on a paid plan).
const MIN_INTERVAL_MS = Number(process.env.TWITTERAPI_IO_MIN_INTERVAL_MS) || 5200;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let lastCallAt = 0;
let queue: Promise<unknown> = Promise.resolve();

async function rlFetch(url: string): Promise<Response> {
  const task = queue.then(async () => {
    const gap = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
    if (gap > 0) await sleep(gap);
    lastCallAt = Date.now();
    const headers = { 'X-API-Key': env.twitterApiIo.apiKey! };
    let res = await fetch(url, { headers, cache: 'no-store' });
    if (res.status === 429) {
      await sleep(MIN_INTERVAL_MS);
      lastCallAt = Date.now();
      res = await fetch(url, { headers, cache: 'no-store' });
    }
    return res;
  });
  // Keep the chain alive even if one call rejects.
  queue = task.then(() => undefined, () => undefined);
  return task;
}

/** One page of advanced search. queryType 'Latest' = reverse-chron, 'Top' =
 *  ranked. `query` accepts standard Twitter search operators. Never throws —
 *  returns an empty page on any failure so a scan degrades gracefully. */
export async function advancedSearch(
  query: string,
  opts: { queryType?: 'Latest' | 'Top'; cursor?: string } = {},
): Promise<{ tweets: TwitterApiIoTweet[]; nextCursor: string | null; hasNextPage: boolean }> {
  if (!isConfigured()) return { tweets: [], nextCursor: null, hasNextPage: false };

  const params = new URLSearchParams({
    query,
    queryType: opts.queryType ?? 'Latest',
  });
  if (opts.cursor) params.set('cursor', opts.cursor);

  try {
    const res = await rlFetch(`${BASE_URL}/twitter/tweet/advanced_search?${params.toString()}`);
    if (!res.ok) return { tweets: [], nextCursor: null, hasNextPage: false };
    const data = (await res.json()) as AdvancedSearchResponse;
    return {
      tweets: Array.isArray(data.tweets) ? data.tweets : [],
      nextCursor: data.next_cursor || null,
      hasNextPage: !!data.has_next_page,
    };
  } catch {
    return { tweets: [], nextCursor: null, hasNextPage: false };
  }
}

/** A resolved X user (from /twitter/user/search). The live API returns
 *  screen_name / followers_count / isBlueVerified; we tolerate the documented
 *  alternate names too. */
export interface XUser {
  handle: string;
  name: string;
  followers: number;
  verified: boolean;
  description: string;
  id: string;
}

/** Search X users by name/keyword — used to resolve a brand name (e.g.
 *  "New Delhi Municipal Council") to its real handle (@tweetndmc). Never throws. */
export async function searchUsers(query: string): Promise<XUser[]> {
  if (!isConfigured()) return [];
  try {
    const res = await rlFetch(`${BASE_URL}/twitter/user/search?${new URLSearchParams({ query })}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { users?: Array<Record<string, unknown>> };
    const users = Array.isArray(data.users) ? data.users : [];
    return users
      .map((u) => ({
        handle: String(u.screen_name ?? u.userName ?? ''),
        name: String(u.name ?? ''),
        followers: Number(u.followers_count ?? u.followers ?? 0),
        verified: Boolean(u.isBlueVerified ?? u.verified ?? false),
        description: String(u.description ?? ''),
        id: String(u.id ?? ''),
      }))
      .filter((u) => u.handle);
  } catch {
    return [];
  }
}

// ── Result cache ──────────────────────────────────────────────────────────────
// Searches cost money, so identical queries are served from an in-process TTL
// cache instead of re-hitting the API. Survives within a warm server process
// (and across the whole dev session). Override TTL via TWITTERAPI_IO_CACHE_TTL_MS.
interface CacheEntry { at: number; tweets: TwitterApiIoTweet[] }
const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 200;
const TTL_MS = Number(process.env.TWITTERAPI_IO_CACHE_TTL_MS) || 15 * 60 * 1000; // 15 min

/** Fetch up to `max` tweets for a query, paginating as needed (each page is
 *  ~20). Results are cached by (queryType, max, query) for TTL_MS so repeat
 *  scans of the same brand don't trigger another paid search. Caps page count
 *  to avoid runaway spend on a noisy brand. Pass { fresh: true } to bypass. */
export async function searchTweets(
  query: string,
  opts: { queryType?: 'Latest' | 'Top'; max?: number; fresh?: boolean } = {},
): Promise<TwitterApiIoTweet[]> {
  const max = Math.min(opts.max ?? 20, 100);
  const queryType = opts.queryType ?? 'Latest';
  const key = `${queryType}:${max}:${query}`;

  if (!opts.fresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.tweets;
  }

  const out: TwitterApiIoTweet[] = [];
  let cursor: string | undefined;
  // Hard page cap (5 pages ≈ 100 tweets) as a spend backstop.
  for (let page = 0; page < 5 && out.length < max; page++) {
    const { tweets, nextCursor, hasNextPage } = await advancedSearch(query, { queryType, cursor });
    out.push(...tweets);
    if (!hasNextPage || !nextCursor) break;
    cursor = nextCursor;
  }
  const result = out.slice(0, max);

  // Only cache non-empty results so a transient failure isn't pinned for 15 min.
  if (result.length > 0) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), tweets: result });
  }
  return result;
}
