/* Pure helpers for LinkedIn auto-discover: turn a free-text company description
   into a short LinkedIn-search keyword, and rank/dedupe the search hits.
   Deterministic (no LLM). Self-check: scripts/check-linkedin-intel.ts. */
import type { LinkedInSearchHit } from '../scrapers/linkedin';

// common English + boilerplate words that add no signal to a company search
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'we', 'our', 'us',
  'is', 'are', 'be', 'that', 'this', 'as', 'at', 'by', 'from', 'it', 'its', 'their', 'you',
  'your', 'company', 'business', 'brand', 'provide', 'providing', 'offer', 'offering', 'services',
  'service', 'solutions', 'solution', 'products', 'product', 'based', 'leading', 'best', 'top',
  'premium', 'quality', 'customers', 'clients', 'india', 'indian', 'about', 'who', 'what', 'we',
]);

/** Distill a description into a <=5-word search keyword: salient tokens by
    frequency, then first-seen order to keep the phrase readable. */
export function descriptionToKeyword(description: string): string {
  const tokens = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
  if (tokens.length === 0) return description.trim().slice(0, 60);

  const freq = new Map<string, number>();
  const order = new Map<string, number>();
  tokens.forEach((t, i) => {
    freq.set(t, (freq.get(t) ?? 0) + 1);
    if (!order.has(t)) order.set(t, i);
  });

  return [...freq.keys()]
    .sort((a, b) => freq.get(b)! - freq.get(a)! || order.get(a)! - order.get(b)!)
    .slice(0, 5)
    .sort((a, b) => order.get(a)! - order.get(b)!)
    .join(' ');
}

/** Rank search hits: drop excluded/self slugs, sort by follower size (bigger =
    more established competitor; the search already handled relevance), cap. */
export function rankLinkedInHits(
  hits: LinkedInSearchHit[],
  opts: { exclude?: Iterable<string>; limit?: number } = {},
): LinkedInSearchHit[] {
  const exclude = new Set([...(opts.exclude ?? [])].map((s) => s.trim().toLowerCase()));
  const seen = new Set<string>();
  const out = hits.filter((h) => {
    const s = h.slug.toLowerCase();
    if (!s || exclude.has(s) || seen.has(s)) return false;
    seen.add(s);
    return true;
  });
  out.sort((a, b) => b.followers - a.followers);
  return out.slice(0, opts.limit ?? 10);
}
