/* Live competitor scraping via Apify's instagram-scraper in `details` mode:
   one run per handle returns profile stats (followers, posts count) plus the
   latest posts, which we map into competitorPosts + a daily competitorMetrics
   row. Stories volume is scraped separately (see ../scrapers/stories.ts) and
   merged in by refresh-competitors.ts. */
import { runActor, extractAudio, normalizeType, toInt, type IgMusicInfo } from './apify-client';

const PROFILE_ACTOR = 'apify~instagram-scraper';

export type ScrapedPost = {
  postUrl: string;
  caption: string | null;
  likes: number;
  comments: number;
  views: number;
  hashtags: string[];
  type: 'reel' | 'carousel' | 'image';
  isReel: boolean;
  audioTitle: string | null;
  theme: string | null;
  postedAt: string | null;
};

// keyword → content theme, derived from caption + hashtags (the actor gives no
// theme field). Niche-agnostic buckets; first match wins, else 'other'.
const THEME_RULES: Array<[string, RegExp]> = [
  ['install', /\b(install|installation|fitting|setup|commission)/i],
  ['room-reveal', /\b(reveal|room tour|walkthrough|transformation|makeover|finished project)/i],
  ['before-after', /\b(before\s*(&|and|\/)?\s*after|before vs)/i],
  ['acoustics', /\b(acoustic|soundproof|treatment|absorption|calibrat|tuning)/i],
  ['gear-review', /\b(review|unbox|gear|first look|specs?|comparison|vs\b)/i],
  ['client-story', /\b(client|customer|testimonial|happy|thank you|delivered)/i],
  ['promo', /\b(offer|sale|deal|discount|price|pricing|book now|dm to|enquir|limited)/i],
  ['tips', /\b(tip|how to|guide|mistake|things to|should you|explained)/i],
  ['bts', /\b(bts|behind the scenes|making of|work in progress|wip)\b/i],
  ['event', /\b(event|expo|launch|showroom|exhibition|demo day)/i],
];

export function deriveTheme(caption: string | null, hashtags: string[]): string | null {
  const hay = `${caption ?? ''} ${hashtags.join(' ')}`;
  for (const [theme, re] of THEME_RULES) if (re.test(hay)) return theme;
  return 'other';
}

export type ScrapedProfile = {
  handle: string;
  displayName: string | null;
  followers: number;
  following: number;
  bio: string | null;
  postsCount: number;
  verified: boolean;
  posts: ScrapedPost[];
};

type IgLatestPost = {
  url?: string;
  type?: string;
  productType?: string;
  caption?: string;
  hashtags?: string[];
  likesCount?: number;
  commentsCount?: number;
  videoViewCount?: number;
  videoPlayCount?: number;
  timestamp?: string;
  musicInfo?: IgMusicInfo;
};
type IgProfile = {
  username?: string;
  fullName?: string;
  followersCount?: number;
  followsCount?: number;
  biography?: string;
  postsCount?: number;
  verified?: boolean;
  private?: boolean;
  error?: string;
  latestPosts?: IgLatestPost[];
};

function mapLatestPost(p: IgLatestPost): ScrapedPost | null {
  if (!p.url) return null;
  const { type, isReel } = normalizeType(p.type, p.productType);
  const { title } = extractAudio(p.musicInfo ?? null);
  const hashtags = Array.isArray(p.hashtags) ? p.hashtags : [];
  return {
    postUrl: p.url,
    caption: p.caption ?? null,
    likes: toInt(p.likesCount),
    comments: toInt(p.commentsCount),
    views: toInt(p.videoViewCount ?? p.videoPlayCount),
    hashtags,
    type,
    isReel,
    audioTitle: title,
    theme: deriveTheme(p.caption ?? null, hashtags),
    postedAt: p.timestamp ?? null,
  };
}

/** Scrape a single public Instagram profile. Returns null if the actor could
    not resolve the handle (private/removed/typo). */
export async function scrapeCompetitor(handle: string): Promise<ScrapedProfile | null> {
  const clean = handle.trim().replace(/^@/, '');
  if (!clean) return null;
  const items = await runActor<IgProfile>(PROFILE_ACTOR, {
    directUrls: [`https://www.instagram.com/${clean}/`],
    resultsType: 'details',
    resultsLimit: 1,
  });
  const p = items[0];
  if (!p || p.error || !p.username) return null;
  return {
    handle: p.username,
    displayName: p.fullName?.trim() || null,
    followers: toInt(p.followersCount),
    following: toInt(p.followsCount),
    bio: p.biography?.trim() || null,
    postsCount: toInt(p.postsCount),
    verified: Boolean(p.verified),
    posts: (p.latestPosts ?? []).map(mapLatestPost).filter((x): x is ScrapedPost => x !== null),
  };
}
