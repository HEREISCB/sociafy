/* Auto-derives niche + tracking hashtags from a free-text company description —
   the "describe your company, get everything" write path (V2_Plan.md §2). Same
   cached-JSON, deterministic-fallback pattern as strategist.ts. */
import { callJson, cacheGetJson, cacheSetJson, hashKey, hasProvider } from './llm';

export type Targeting = { niche: string; hashtags: string[]; keywords: string[] };

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from',
  'is', 'are', 'was', 'were', 'we', 'our', 'us', 'you', 'your', 'it', 'its', 'this', 'that', 'these',
  'those', 'as', 'be', 'been', 'being', 'all', 'across', 'into', 'over', 'out', 'up', 'down', 'than',
  'then', 'so', 'such', 'also', 'more', 'most', 'some', 'any', 'each', 'every', 'one', 'two', 'three',
]);

/** Pure, deterministic. Never throws; never returns empty niche/hashtags for
    non-empty input — onboarding must not hard-block in demo mode. */
export function deterministicTargeting(description: string): Targeting {
  const trimmed = description.trim();
  const firstSentence = (trimmed.match(/^[^.!?]+[.!?]?/)?.[0] ?? trimmed).trim();
  const niche = (firstSentence || 'General brand').slice(0, 140);

  const tokens = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  const candidates = [...new Set(tokens)];

  return {
    niche,
    hashtags: candidates.length ? candidates.slice(0, 10) : ['brand'],
    keywords: candidates.length ? candidates.slice(0, 15) : ['brand'],
  };
}

export async function deriveTargeting(description: string): Promise<Targeting> {
  const fallback = deterministicTargeting(description);
  if (!hasProvider() || !description.trim()) return fallback;

  const key = hashKey('targeting', description.trim());
  const cached = await cacheGetJson<Targeting>(key);
  const llm = cached ?? await callJson<Targeting>(
    `A brand describes itself: "${description.trim()}"\n` +
    `Derive Instagram trend-tracking targeting for this brand.\n` +
    `Return ONLY JSON: {"niche":"<=8 word niche label>","hashtags":["8-12 lowercase Instagram hashtags, no # symbol, no spaces"],"keywords":["5-10 short keywords"]}`,
    500,
  );
  if (cached === null && llm) await cacheSetJson(key, llm);

  const cleanHashtags = (llm?.hashtags ?? [])
    .map((h) => h.replace(/[^a-z0-9]/gi, '').toLowerCase())
    .filter(Boolean)
    .slice(0, 12);
  if (!llm?.niche || cleanHashtags.length === 0) return fallback;

  return {
    niche: llm.niche.slice(0, 140),
    hashtags: cleanHashtags,
    keywords: (llm.keywords ?? []).slice(0, 15),
  };
}
