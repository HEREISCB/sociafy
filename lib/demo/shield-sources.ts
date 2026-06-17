const UA = 'Mozilla/5.0 (compatible; SociafyReputationShieldDemo/1.0)';

export interface RawMention {
  id: string;
  source: 'google_news' | 'hackernews' | 'wikipedia';
  url: string;
  title: string;
  body: string;
  author: string;
  engagement: number;
  timestamp: number;
}

// ── Google News RSS (free, no auth, 100 results) ──────────────────────────────

export async function fetchGoogleNews(brand: string): Promise<RawMention[]> {
  const q = encodeURIComponent(`"${brand}"`);
  try {
    const res = await fetch(
      `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
      { headers: { 'User-Agent': UA }, cache: 'no-store' }
    );
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSSItems(xml, 'google_news');
  } catch {
    return [];
  }
}

// Also fetch a "controversy" query to surface negative coverage specifically
export async function fetchGoogleNewsControversy(brand: string): Promise<RawMention[]> {
  const q = encodeURIComponent(`"${brand}" (controversy OR scandal OR lawsuit OR problem OR issue OR fail)`);
  try {
    const res = await fetch(
      `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
      { headers: { 'User-Agent': UA }, cache: 'no-store' }
    );
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSSItems(xml, 'google_news');
  } catch {
    return [];
  }
}

function parseRSSItems(xml: string, source: RawMention['source']): RawMention[] {
  const itemBlocks = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
  return itemBlocks.slice(0, 40).map((block, i) => {
    const title = extractXML(block, 'title');
    const link  = extractXML(block, 'link');
    const desc  = extractXML(block, 'description');
    const pub   = extractXML(block, 'pubDate');
    // Google News wraps source name in <source>
    const src   = extractXML(block, 'source') || 'news';

    return {
      id: `${source}-${i}-${hashStr(link || title)}`,
      source,
      url: link,
      title: cleanText(title),
      body: cleanText(desc).slice(0, 400),
      author: cleanText(src),
      engagement: 80 + i,   // news items assumed moderate reach; earlier = higher
      timestamp: pub ? Date.parse(pub) / 1000 : Date.now() / 1000,
    };
  }).filter(m => m.title.length > 5);
}

function extractXML(block: string, tag: string): string {
  // Handles both <![CDATA[...]]> and plain text
  const cdataRx = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const plainRx = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const cdata = block.match(cdataRx)?.[1];
  if (cdata) return cdata.trim();
  const plain = block.match(plainRx)?.[1];
  if (plain) return plain.trim();
  // <link> is sometimes self-closing text node without closing tag
  if (tag === 'link') {
    const inline = block.match(/<link\s*\/>|<link>(.*?)</)?.[1];
    return inline?.trim() ?? '';
  }
  return '';
}

function cleanText(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, '')
    .trim();
}

function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// ── Hacker News via Algolia (free, no auth) ───────────────────────────────────

export async function fetchHackerNews(brand: string): Promise<RawMention[]> {
  const q = encodeURIComponent(`"${brand}"`);
  try {
    const res = await fetch(
      `https://hn.algolia.com/api/v1/search?query=${q}&tags=story&hitsPerPage=30`,
      { headers: { 'User-Agent': UA }, cache: 'no-store' }
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
  } catch {
    return [];
  }
}

// ── Wikipedia Search (free, no auth — surfaces notable controversies) ─────────

export async function fetchWikipedia(brand: string): Promise<RawMention[]> {
  // Two queries: general brand + brand controversies
  const [general, controversy] = await Promise.allSettled([
    wikiSearch(`${brand} controversy criticism scandal`),
    wikiSearch(`${brand} lawsuit investigation`),
  ]);

  const items = [
    ...(general.status === 'fulfilled' ? general.value : []),
    ...(controversy.status === 'fulfilled' ? controversy.value : []),
  ];

  // De-dup by title
  const seen = new Set<string>();
  return items.filter(m => {
    if (seen.has(m.title)) return false;
    seen.add(m.title);
    return true;
  });
}

async function wikiSearch(query: string): Promise<RawMention[]> {
  const q = encodeURIComponent(query);
  try {
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&format=json&srlimit=8&srprop=snippet|titlesnippet|size`,
      { headers: { 'User-Agent': UA }, cache: 'no-store' }
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
      engagement: Math.max(50, (r.size ?? 0) / 100), // article size as proxy for reach
      timestamp: Date.now() / 1000 - 86400, // treat as 1d old
    })).filter(m => m.title.length > 3);
  } catch {
    return [];
  }
}
