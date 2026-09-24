/**
 * Free public text tools (/free-*). Pure data + parsing, safe to import anywhere.
 * FREE_TOOL_PAGES is the list to add to the sitemap and footer.
 */

export const FREE_TOOL_IDS = ['caption', 'hashtag', 'linkedin', 'bio', 'tweet', 'youtube'] as const;
export type FreeToolId = (typeof FREE_TOOL_IDS)[number];

export const FREE_TONES = ['friendly', 'professional', 'witty', 'bold', 'inspirational'] as const;

export const FREE_TOOLS: Record<FreeToolId, { slug: string; title: string }> = {
  caption: { slug: '/free-instagram-caption-generator', title: 'Instagram caption generator' },
  hashtag: { slug: '/free-hashtag-generator', title: 'Hashtag generator' },
  linkedin: { slug: '/free-linkedin-post-generator', title: 'LinkedIn post generator' },
  bio: { slug: '/free-bio-generator', title: 'Social media bio generator' },
  tweet: { slug: '/free-tweet-generator', title: 'Tweet / X post generator' },
  youtube: { slug: '/free-youtube-title-generator', title: 'YouTube title & description generator' },
};

/** Every free tool page, text and media, for the sitemap, footer and hub. */
export const FREE_TOOL_PAGES: { slug: string; title: string }[] = [
  { slug: '/free-tools', title: 'Free social media tools' },
  ...FREE_TOOL_IDS.map((id) => FREE_TOOLS[id]),
  { slug: '/try-image', title: 'AI image generator' },
  { slug: '/try-video', title: 'AI video generator' },
];

const JSON_RULE = 'Reply with JSON only, shaped exactly {"results": ["...", "..."]}. Each result is a complete, ready-to-paste string. No markdown, no commentary, no numbering inside the strings.';

/** System prompt + output budget per tool. Budgets are tight on purpose: these are free. */
export const FREE_TOOL_PROMPTS: Record<FreeToolId, { system: string; maxOutputTokens: number }> = {
  caption: {
    maxOutputTokens: 900,
    system: `You write Instagram captions. Given what the post is about, write 5 distinct captions: vary the hook (question, bold claim, story, list, one-liner). Each is 1-4 short lines, may use a few fitting emojis, ends with a light call to action, and has no hashtags. ${JSON_RULE}`,
  },
  hashtag: {
    maxOutputTokens: 600,
    system: `You pick hashtags for Instagram, TikTok and LinkedIn. Given a topic, return 3 results, each a single space-separated line of 10 relevant hashtags: result 1 broad high-reach tags, result 2 mid-size community tags, result 3 niche, specific tags. No duplicates, no banned or spammy tags, lowercase or CamelCase only. ${JSON_RULE}`,
  },
  linkedin: {
    maxOutputTokens: 1600,
    system: `You write LinkedIn posts. Given a topic or rough notes, write 3 distinct posts of 80-180 words each: a strong first line that earns the "see more" click, short paragraphs with line breaks, one concrete insight or story, and a closing question. No hashtag walls (at most 3 at the end), no clichés like "I'm humbled". ${JSON_RULE}`,
  },
  bio: {
    maxOutputTokens: 500,
    system: `You write social media bios. Given who the person or brand is, write 5 distinct bios, each strictly under 150 characters (Instagram's limit), saying who they are, what they offer and who it's for. Some may use one or two emojis or a line break. ${JSON_RULE}`,
  },
  tweet: {
    maxOutputTokens: 800,
    system: `You write posts for X (Twitter). Given a topic, write 5 distinct posts, each strictly under 280 characters: vary the format (hot take, tip, mini-story, question, list). Punchy, specific, no hashtags unless essential, at most one emoji. ${JSON_RULE}`,
  },
  youtube: {
    maxOutputTokens: 1200,
    system: `You write YouTube titles and descriptions. Given what the video is about, return 7 results: the first 5 are distinct titles under 70 characters (curiosity or clear benefit, front-load the keyword, no clickbait lies); the last 2 are distinct descriptions of 80-150 words that open with a keyword-rich summary in the first two lines, then what viewers will learn, then a subscribe call to action. ${JSON_RULE}`,
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
    items = text.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''));
  }
  return (items ?? [])
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
}
