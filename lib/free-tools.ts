/**
 * Free public text tools (/free-*). Pure data + parsing, safe to import anywhere.
 * FREE_TOOL_PAGES is the list to add to the sitemap and footer.
 */
import { TRY_PAGES } from './try-presets';
import { VOICE_RULES } from './ai/voice-rules';

export const FREE_TOOL_IDS = ['caption', 'hashtag', 'linkedin', 'bio', 'tweet', 'youtube'] as const;
export type FreeToolId = (typeof FREE_TOOL_IDS)[number];

export const FREE_TONES = ['friendly', 'professional', 'witty', 'bold', 'inspirational'] as const;

type FreeTool = {
  slug: string;
  title: string;
  /** One-line job, for the hub card. */
  blurb: string;
  /** A sample output, for the hub and landing cards. */
  sample: string;
  /** Textarea hint; deliberately not one of the example chips. */
  placeholder: string;
  /** What comes back, for the empty state: "Five captions". */
  makes: string;
  /** Header over the results: "5 captions". */
  noun: string;
  /** Per-result labels by position (the prompt fixes the order). */
  labels?: string[];
};

export const FREE_TOOLS: Record<FreeToolId, FreeTool> = {
  caption: {
    slug: '/free-instagram-caption-generator', title: 'Instagram caption generator',
    blurb: 'Five captions, five different hooks.', sample: 'Cold-brew season is back. 18 hours of patience in every bottle.',
    placeholder: 'e.g. our winter cold-brew is back, 20% off this week',
    makes: 'Five captions', noun: 'captions',
  },
  hashtag: {
    slug: '/free-hashtag-generator', title: 'Hashtag generator',
    blurb: '30 tags in broad, community and niche sets.', sample: '#coldbrew #bengalurucafe #specialtycoffeeindia',
    placeholder: 'e.g. a small-batch coffee roaster in Bengaluru',
    makes: 'Three sets of ten hashtags', noun: 'hashtag sets', labels: ['Broad', 'Community', 'Niche'],
  },
  linkedin: {
    slug: '/free-linkedin-post-generator', title: 'LinkedIn post generator',
    blurb: 'Three posts with a first line worth the click.', sample: 'We almost didn’t launch the winter batch. Here is why we did.',
    placeholder: 'e.g. what we learned shipping our first paid feature',
    makes: 'Three LinkedIn posts', noun: 'posts',
  },
  bio: {
    slug: '/free-bio-generator', title: 'Social media bio generator',
    blurb: 'Five bios under 150 characters.', sample: 'Small-batch cold brew, steeped 18 h. Bengaluru delivery.',
    placeholder: 'e.g. freelance designer who brands small cafés',
    makes: 'Five bios', noun: 'bios',
  },
  tweet: {
    slug: '/free-tweet-generator', title: 'Tweet / X post generator',
    blurb: 'Five posts under 280 characters.', sample: 'Cold brew is not iced coffee. Thread on why it tastes sweeter.',
    placeholder: 'e.g. why we stopped doing weekly status meetings',
    makes: 'Five posts', noun: 'posts',
  },
  youtube: {
    slug: '/free-youtube-title-generator', title: 'YouTube title & description generator',
    blurb: 'Five titles and two descriptions.', sample: 'I steeped coffee for 18 hours. Here is what changed',
    placeholder: 'e.g. testing three budget espresso machines for a month',
    makes: 'Five titles and two descriptions', noun: 'results',
    labels: ['Title', 'Title', 'Title', 'Title', 'Title', 'Description', 'Description'],
  },
};

/** Stated on the pages; the limit itself is the freeText bucket in lib/rate-limit. */
export const FREE_TEXT_PER_HOUR = 10;

/** Every free tool page, text and media, for the sitemap, footer and hub. */
export const FREE_TOOL_PAGES: { slug: string; title: string }[] = [
  { slug: '/free-tools', title: 'Free social media tools' },
  ...FREE_TOOL_IDS.map((id) => ({ slug: FREE_TOOLS[id].slug, title: FREE_TOOLS[id].title })),
  ...TRY_PAGES.map((t) => ({ slug: t.path, title: t.title })),
];

const JSON_RULE = 'Reply with JSON only, shaped exactly {"results": ["...", "..."]}. Each result is a complete, ready-to-paste string. No markdown, no commentary, no numbering inside the strings.';
/** Tools that write prose get the shared style rules; the hashtag tool doesn't. */
const WRITE_RULE = `${VOICE_RULES}\n${JSON_RULE}`;

/** System prompt + output budget per tool. Budgets are tight on purpose: these are free. */
export const FREE_TOOL_PROMPTS: Record<FreeToolId, { system: string; maxOutputTokens: number }> = {
  caption: {
    maxOutputTokens: 900,
    system: `You write Instagram captions. Given what the post is about, write 5 distinct captions: vary the hook (bold claim, story, specific detail, list, one-liner). Each is 1-4 short lines, may use a few fitting emojis, ends with a light call to action, and has no hashtags. ${WRITE_RULE}`,
  },
  hashtag: {
    maxOutputTokens: 600,
    system: `You pick hashtags for Instagram, TikTok and LinkedIn. Given a topic, return 3 results, each a single space-separated line of 10 relevant hashtags: result 1 broad high-reach tags, result 2 mid-size community tags, result 3 niche, specific tags. No duplicates, no banned or spammy tags, lowercase or CamelCase only. ${JSON_RULE}`,
  },
  linkedin: {
    maxOutputTokens: 1600,
    system: `You write LinkedIn posts. Given a topic or rough notes, write 3 distinct posts of 80-180 words each: a strong first line that earns the "see more" click, short paragraphs with line breaks, one concrete insight or story, and a plain closing line (no "What do you think?" bait). No hashtag walls (at most 3 at the end), no clichés like "I'm humbled". ${WRITE_RULE}`,
  },
  bio: {
    maxOutputTokens: 500,
    system: `You write social media bios. Given who the person or brand is, write 5 distinct bios, each strictly under 150 characters (Instagram's limit), saying who they are, what they offer and who it's for. Some may use one or two emojis or a line break. ${WRITE_RULE}`,
  },
  tweet: {
    maxOutputTokens: 800,
    system: `You write posts for X (Twitter). Given a topic, write 5 distinct posts, each strictly under 280 characters: vary the format (hot take, tip, mini-story, observation, list). Punchy, specific, no hashtags unless essential, at most one emoji. ${WRITE_RULE}`,
  },
  youtube: {
    maxOutputTokens: 1200,
    system: `You write YouTube titles and descriptions. Given what the video is about, return 7 results: the first 5 are distinct titles under 70 characters (curiosity or clear benefit, front-load the keyword, no clickbait lies); the last 2 are distinct descriptions of 80-150 words that open with a keyword-rich summary in the first two lines, then what viewers will learn, then a subscribe call to action. ${WRITE_RULE}`,
  },
};

/**
 * Model text -> clean list of results. Prefers the JSON shape we asked for;
 * falls back to one result per non-empty line when the model ignores JSON mode.
 */
export function parseResults(raw: string, max = 10): string[] {
  const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let items: unknown[] | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) items = parsed;
    else if (parsed && typeof parsed === 'object') {
      const arr = Object.values(parsed).find(Array.isArray);
      if (arr) items = arr;
    }
  } catch {
    // Truncated JSON (model hit its token cap): keep every string that closed.
    // Anything else: one result per line.
    items = /^[[{]/.test(text)
      // Consume every complete string literal (keys too, so matching stays aligned), then drop the keys.
      ? [...text.matchAll(/"(?:[^"\\]|\\.)*"/g)]
          .filter((m) => !/^\s*:/.test(text.slice(m.index + m[0].length)))
          .map((m) => JSON.parse(m[0]) as string)
      : text.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''));
  }
  return (items ?? [])
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
}
