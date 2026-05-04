import type { Niche } from '../db/schema';

export type TrendCandidate = {
  niche: Niche;
  title: string;
  summary?: string;
  source: string;
  sourceUrl: string;
  volume?: number;
  delta?: number;
};

// Hacker News + Reddit RSS feeds, mapped to niches. Free, no auth required.
const SOURCES: Array<{ niche: Niche; source: string; url: string }> = [
  { niche: 'saas',           source: 'HN: Show',         url: 'https://hnrss.org/show' },
  { niche: 'saas',           source: 'r/SaaS',           url: 'https://www.reddit.com/r/SaaS/.rss' },
  { niche: 'creator-economy',source: 'r/creatoreconomy', url: 'https://www.reddit.com/r/creatoreconomy/.rss' },
  { niche: 'marketing',      source: 'r/marketing',      url: 'https://www.reddit.com/r/marketing/.rss' },
  { niche: 'ai',             source: 'HN: AI',           url: 'https://hnrss.org/newest?q=AI' },
  { niche: 'ai',             source: 'r/MachineLearning',url: 'https://www.reddit.com/r/MachineLearning/.rss' },
  { niche: 'design',         source: 'r/web_design',     url: 'https://www.reddit.com/r/web_design/.rss' },
  { niche: 'devtools',       source: 'HN: devtools',     url: 'https://hnrss.org/newest?q=devtools' },
  { niche: 'fintech',        source: 'r/fintech',        url: 'https://www.reddit.com/r/fintech/.rss' },
  { niche: 'media',          source: 'r/media',          url: 'https://www.reddit.com/r/media_criticism/.rss' },
  { niche: 'community',      source: 'r/community',      url: 'https://www.reddit.com/r/CommunityManager/.rss' },
];

const TITLE_RX = /<title>([^<]+)<\/title>/g;
const LINK_RX = /<link>([^<]+)<\/link>/g;
// crude RSS/atom parsing — enough for our needs and avoids extra deps
function parseFeed(xml: string): { title: string; url: string }[] {
  const titles: string[] = [];
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = TITLE_RX.exec(xml))) titles.push(decode(m[1]));
  while ((m = LINK_RX.exec(xml))) links.push(decode(m[1]));
  // first title/link are usually channel-level — skip
  const items: { title: string; url: string }[] = [];
  for (let i = 1; i < Math.min(titles.length, links.length); i++) {
    if (titles[i] && links[i]) items.push({ title: titles[i], url: links[i] });
  }
  return items.slice(0, 10);
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .trim();
}

export async function fetchTrendsForNiches(niches: Niche[]): Promise<TrendCandidate[]> {
  const targets = SOURCES.filter((s) => niches.includes(s.niche));
  if (targets.length === 0) return stubTrends(niches);
  const out: TrendCandidate[] = [];
  await Promise.all(
    targets.map(async (t) => {
      try {
        const resp = await fetch(t.url, {
          headers: { 'User-Agent': 'sociafy-trends/1.0 (+https://sociafy.app)' },
          next: { revalidate: 600 },
        });
        if (!resp.ok) return;
        const xml = await resp.text();
        const items = parseFeed(xml);
        for (const item of items.slice(0, 5)) {
          out.push({
            niche: t.niche,
            title: item.title,
            source: t.source,
            sourceUrl: item.url,
            volume: 1,
            delta: 0,
          });
        }
      } catch {
        // ignore — trend ingest is best-effort
      }
    }),
  );
  return out.length > 0 ? out : stubTrends(niches);
}

export function stubTrends(niches: Niche[]): TrendCandidate[] {
  const samples: Array<{ niche: Niche; titles: string[] }> = [
    {
      niche: 'saas',
      titles: ['Onboarding flows that don\'t suck', 'Pricing pages with one job', 'Why founder-led sales still wins'],
    },
    {
      niche: 'creator-economy',
      titles: ['The newsletter renaissance is real', 'Creators are quietly building media empires', 'Why your audience cares about your stack'],
    },
    {
      niche: 'marketing',
      titles: ['Distribution > craft', 'Cold email isn\'t dead, your offer is', 'The one-line framework for landing pages'],
    },
    {
      niche: 'ai',
      titles: ['Agents are eating workflows', 'Why eval is the new feature', 'The death of the prompt template'],
    },
    {
      niche: 'design',
      titles: ['Brutalism is back, again', 'Type pairing rules nobody told you', 'Designing for cognitive load'],
    },
    { niche: 'devtools',  titles: ['DX as a moat', 'Build > buy in 2026', 'Logs as the new dashboards'] },
    { niche: 'fintech',   titles: ['Embedded finance everywhere', 'KYC fatigue is real', 'Stablecoins for SMB payouts'] },
    { niche: 'media',     titles: ['The unbundling of news', 'Audio-first storytelling returns', 'Vertical first, always'] },
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
