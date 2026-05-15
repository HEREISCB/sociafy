import type { Niche } from '../db/schema';

export type TrendCandidate = {
  niche: string; // accept any string — custom niches included
  title: string;
  summary?: string;
  source: string;
  sourceUrl: string;
  volume?: number;
  delta?: number;
};

// Map a niche slug to keywords used to query open APIs. Predefined slugs map
// to curated keyword sets; unknown / custom niches use the slug itself.
const KEYWORDS: Record<string, string[]> = {
  saas: ['saas', 'b2b sales', 'pricing strategy', 'founder-led'],
  'creator-economy': ['creator economy', 'newsletter', 'audience growth'],
  marketing: ['marketing', 'gtm', 'distribution', 'growth'],
  ai: ['agentic', 'llm', 'agents', 'rag', 'evals'],
  design: ['product design', 'ux', 'typography', 'brand identity'],
  devtools: ['developer tools', 'devex', 'observability', 'open source'],
  fintech: ['fintech', 'embedded finance', 'payments', 'stablecoin'],
  media: ['podcast', 'video editing', 'vertical video', 'media business'],
  community: ['community building', 'discord moderation', 'cohort course'],
};

// Reddit subs per niche — for richer signal. Always paired with our HN + dev.to layer.
const REDDIT_SUBS: Record<string, string[]> = {
  saas: ['SaaS', 'startups', 'Entrepreneur'],
  'creator-economy': ['creatoreconomy', 'NewTubers', 'NewsletterPro'],
  marketing: ['marketing', 'growthhacking', 'SEO'],
  ai: ['LocalLLaMA', 'MachineLearning', 'singularity'],
  design: ['web_design', 'graphic_design', 'UI_Design'],
  devtools: ['programming', 'devops', 'opensource'],
  fintech: ['fintech', 'CryptoCurrency'],
  media: ['videography', 'podcasting'],
  community: ['CommunityManager', 'discordapp'],
};

const UA = 'sociafy/0.1 (+https://sociafy.app; trend-ingest)';

function keywordsFor(niche: string): string[] {
  return KEYWORDS[niche] ?? [niche.replace(/-/g, ' ')];
}

function subsFor(niche: string): string[] {
  return REDDIT_SUBS[niche] ?? [];
}

// ----- Hacker News via Algolia (rock-solid, no auth) -----
type AlgoliaHit = {
  objectID: string;
  title?: string | null;
  url?: string | null;
  story_url?: string | null;
  story_title?: string | null;
  points?: number;
  num_comments?: number;
  created_at?: string;
};

async function fetchHN(niche: string, keyword: string): Promise<TrendCandidate[]> {
  try {
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(keyword)}&tags=story&hitsPerPage=8&numericFilters=points%3E=5`;
    const r = await fetch(url, { next: { revalidate: 600 } });
    if (!r.ok) return [];
    const data = (await r.json()) as { hits: AlgoliaHit[] };
    return data.hits
      .filter((h) => (h.title || h.story_title) && (h.url || h.story_url))
      .slice(0, 4)
      .map((h) => ({
        niche,
        title: (h.title ?? h.story_title ?? '').trim(),
        source: 'Hacker News',
        sourceUrl: (h.url ?? h.story_url) as string,
        volume: h.points ?? undefined,
        delta: h.num_comments ?? undefined,
      }));
  } catch {
    return [];
  }
}

// ----- dev.to (no auth, JSON API) -----
type DevToArticle = {
  id: number;
  title: string;
  description?: string;
  url: string;
  public_reactions_count?: number;
  comments_count?: number;
  published_at: string;
  tag_list?: string[];
};

async function fetchDevTo(niche: string): Promise<TrendCandidate[]> {
  try {
    // Try tag form first, fall back to a generic top feed if the tag has no posts.
    const tag = niche.split(' ')[0].toLowerCase();
    const url = `https://dev.to/api/articles?per_page=8&top=7${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`;
    const r = await fetch(url, { next: { revalidate: 600 } });
    if (!r.ok) return [];
    const arts = (await r.json()) as DevToArticle[];
    return arts.slice(0, 4).map((a) => ({
      niche,
      title: a.title,
      summary: a.description,
      source: 'dev.to',
      sourceUrl: a.url,
      volume: a.public_reactions_count ?? undefined,
      delta: a.comments_count ?? undefined,
    }));
  } catch {
    return [];
  }
}

// ----- Reddit JSON (requires a real UA, lenient otherwise) -----
type RedditChild = {
  data: {
    id: string;
    title: string;
    selftext?: string;
    url?: string;
    permalink: string;
    score?: number;
    num_comments?: number;
    created_utc: number;
  };
};

async function fetchReddit(niche: string, sub: string): Promise<TrendCandidate[]> {
  try {
    const url = `https://www.reddit.com/r/${sub}/top.json?limit=10&t=day`;
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      next: { revalidate: 600 },
    });
    if (!r.ok) return [];
    const data = (await r.json()) as { data: { children: RedditChild[] } };
    return data.data.children.slice(0, 3).map((c) => ({
      niche,
      title: c.data.title,
      summary: c.data.selftext ? c.data.selftext.slice(0, 280) : undefined,
      source: `Reddit /r/${sub}`,
      sourceUrl: c.data.url && c.data.url.startsWith('http') ? c.data.url : `https://www.reddit.com${c.data.permalink}`,
      volume: c.data.score ?? undefined,
      delta: c.data.num_comments ?? undefined,
    }));
  } catch {
    return [];
  }
}

export async function fetchTrendsForNiches(niches: string[]): Promise<TrendCandidate[]> {
  if (niches.length === 0) return [];

  const jobs: Promise<TrendCandidate[]>[] = [];
  for (const niche of niches) {
    // Per niche: one HN search per keyword, one dev.to query, top 2 subreddits.
    for (const kw of keywordsFor(niche).slice(0, 2)) {
      jobs.push(fetchHN(niche, kw));
    }
    jobs.push(fetchDevTo(niche));
    for (const sub of subsFor(niche).slice(0, 2)) {
      jobs.push(fetchReddit(niche, sub));
    }
  }

  const results = await Promise.all(jobs);
  const flat = results.flat();

  // Deduplicate by sourceUrl, keep the highest-scored variant
  const seen = new Map<string, TrendCandidate>();
  for (const c of flat) {
    if (!c.title || !c.sourceUrl) continue;
    const key = c.sourceUrl;
    const existing = seen.get(key);
    if (!existing || (c.volume ?? 0) > (existing.volume ?? 0)) {
      seen.set(key, c);
    }
  }

  if (seen.size === 0) {
    return stubTrends(niches as Niche[]);
  }
  return Array.from(seen.values()).slice(0, 24);
}

export function stubTrends(niches: Niche[]): TrendCandidate[] {
  const samples: Array<{ niche: Niche; titles: string[] }> = [
    { niche: 'saas', titles: ["Onboarding flows that don't suck", 'Pricing pages with one job', 'Why founder-led sales still wins'] },
    { niche: 'creator-economy', titles: ['The newsletter renaissance is real', 'Creators are quietly building media empires', 'Why your audience cares about your stack'] },
    { niche: 'marketing', titles: ['Distribution > craft', "Cold email isn't dead, your offer is", 'The one-line framework for landing pages'] },
    { niche: 'ai', titles: ['Agents are eating workflows', 'Why eval is the new feature', 'The death of the prompt template'] },
    { niche: 'design', titles: ['Brutalism is back, again', 'Type pairing rules nobody told you', 'Designing for cognitive load'] },
    { niche: 'devtools', titles: ['DX as a moat', 'Build > buy in 2026', 'Logs as the new dashboards'] },
    { niche: 'fintech', titles: ['Embedded finance everywhere', 'KYC fatigue is real', 'Stablecoins for SMB payouts'] },
    { niche: 'media', titles: ['The unbundling of news', 'Audio-first storytelling returns', 'Vertical first, always'] },
    { niche: 'community', titles: ['Discord vs Slack for founders', 'The 1% rule still holds', 'Onboarding new members in 60s'] },
  ];
  const out: TrendCandidate[] = [];
  for (const s of samples) {
    if (!niches.includes(s.niche)) continue;
    s.titles.forEach((t, i) =>
      out.push({
        niche: s.niche,
        title: t,
        source: 'sociafy:samples',
        sourceUrl: 'https://sociafy.app/trends',
        volume: 100 + i * 10,
        delta: i * 0.2,
      }),
    );
  }
  return out;
}
