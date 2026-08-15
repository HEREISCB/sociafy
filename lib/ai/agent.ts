import { getTextAI, completeText } from './client';
import type { Niche, Platform, VoiceTemplate } from '../db/schema';
import { PLATFORM_LIMITS } from './compose';
import { runAgentLoop, webSearchTool } from './agent-loop';
import { fetchUrlSkill } from './skills/fetch-url';
import { readRecentPostsSkill, readRecentDraftsSkill } from './skills/posts';
import { searchImagesSkill } from './skills/images';

export type AgentDraft = {
  title: string;
  body: string;
  perPlatform: Partial<Record<Platform, string>>;
  score: number;
  rationale: string;
  trendId?: string;
  suggestedImageUrl?: string | null;
};

export type DraftAgentArgs = {
  /** Optional userId — when provided the agent gets read access to past posts/drafts. */
  userId?: string;
  instructions: string;
  voiceTemplate: VoiceTemplate;
  niches: Niche[];
  platforms: Platform[];
  brandSafetyStrict: boolean;
  trends: Array<{ id: string; niche: string; title: string; summary?: string | null; sourceUrl?: string | null }>;
  count: number;
  /** Enable web_search + url fetch + image search tools. Defaults to true. */
  enableTools?: boolean;
};

export async function draftFromTrends(args: DraftAgentArgs): Promise<AgentDraft[]> {
  const ai = getTextAI('smart');
  if (!ai) return stubDrafts(args);

  // Tool loops need the Responses API + OpenAI-hosted web_search. On Groq we
  // draft single-shot from the trend digest instead of stubbing out.
  const enableTools = args.enableTools !== false && ai.supportsTools;

  const sys = [
    'You are an autonomous social media agent for a solo founder.',
    `Their style guide:\n${args.instructions}`,
    `Voice template: ${args.voiceTemplate}`,
    `Niches they post about: ${args.niches.join(', ') || 'general'}`,
    `Brand safety: ${args.brandSafetyStrict ? 'strict — refuse posts that mention competitors negatively, unverified claims, or sensitive topics' : 'standard'}`,
    '',
    ...(enableTools
      ? [
          'Workflow:',
          '1. Optionally call `web_search` to verify a trend is current and find a sharp angle.',
          '2. Optionally call `fetch_url` to read the source article in full before drafting.',
          '3. Optionally call `read_recent_posts` to learn what topics/formats work for THIS user.',
          '4. Optionally call `search_images` if a draft needs visual support.',
          '5. Then output your drafts as STRICT JSON.',
          '',
        ]
      : []),
    'Output rules:',
    enableTools
      ? '- After tool calls, your FINAL message must be ONLY a JSON object. No markdown fences. No commentary.'
      : '- Your reply must be ONLY a JSON object. No markdown fences. No commentary.',
    '- Schema: { "drafts": [ { "title": string, "body": string, "perPlatform": { ... }, "score": 0-100, "rationale": string, "trendId": string | null, "suggestedImageUrl": string | null } ] }',
    `- Produce ${args.count} drafts. Each tied to a different trend if possible.`,
    `- Score reflects: hook strength, on-brand fit, novelty, AND signal from the user's past engagement. ≥ 90 means safe to auto-publish.`,
    `- If a trend is irrelevant or unsafe for this user, skip it (do not produce a draft for it).`,
    'Platform constraints:',
    ...args.platforms.map((p) => `- ${p}: ${PLATFORM_LIMITS[p].notes} stay under ${PLATFORM_LIMITS[p].hard} chars.`),
  ].join('\n');

  const user = [
    'Trends to draft from (pick the strongest):',
    ...args.trends.map(
      (t) => `- [${t.id}] (${t.niche}) ${t.title}${t.summary ? ` — ${t.summary}` : ''}${t.sourceUrl ? ` (${t.sourceUrl})` : ''}`,
    ),
  ].join('\n');

  console.log(`[agent] provider=${ai.kind} tools=${enableTools} trends=${args.trends.length}`);

  let text: string;
  if (enableTools) {
    const result = await runAgentLoop({
      model: 'smart',
      system: sys,
      user,
      tools: [
        webSearchTool(),
        fetchUrlSkill,
        ...(args.userId ? [readRecentPostsSkill(args.userId), readRecentDraftsSkill(args.userId)] : []),
        searchImagesSkill,
      ],
      maxSteps: 6,
      maxOutputTokens: 3500,
    });
    if (!result) return stubDrafts(args);
    text = result.text;
  } else {
    text = await completeText(ai, { system: sys, user, maxOutputTokens: 3500, json: true });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return stubDrafts(args);
  }
  const drafts = coerceDrafts(parsed, args.platforms).slice(0, args.count);
  return drafts.length > 0 ? drafts : stubDrafts(args);
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.slice(0, max) : '';

/**
 * The model's JSON is untrusted input: `score` decides whether a draft is
 * auto-published to a real account, so it gets clamped to 0-100 and anything
 * unparseable scores 0 (never auto-publishes — the lowest selectable
 * threshold is above 0). Drafts with no body are dropped outright.
 */
export function coerceDrafts(parsed: unknown, platforms: Platform[]): AgentDraft[] {
  const raw = (parsed as { drafts?: unknown })?.drafts;
  if (!Array.isArray(raw)) return [];
  const out: AgentDraft[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;
    const body = str(d.body, 20_000);
    if (!body.trim()) continue;

    const perPlatform: Partial<Record<Platform, string>> = {};
    const pp = (d.perPlatform ?? {}) as Record<string, unknown>;
    if (pp && typeof pp === 'object') {
      for (const p of platforms) {
        const t = str(pp[p], PLATFORM_LIMITS[p].hard);
        if (t) perPlatform[p] = t;
      }
    }

    const n = Number(d.score);
    out.push({
      title: str(d.title, 280) || body.slice(0, 80),
      body,
      perPlatform,
      score: Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0,
      rationale: str(d.rationale, 2_000),
      trendId: typeof d.trendId === 'string' ? d.trendId : undefined,
      suggestedImageUrl: typeof d.suggestedImageUrl === 'string' ? d.suggestedImageUrl : null,
    });
  }
  return out;
}

function stubDrafts(args: DraftAgentArgs): AgentDraft[] {
  const trend = args.trends[0];
  if (!trend) return [];
  const body = `Quick read on ${trend.title}:\n\nWhat actually matters here is execution. The story behind the story is that solo founders who ship 3 small things a week beat teams of 5 every time.`;
  const perPlatform: Partial<Record<Platform, string>> = {};
  for (const p of args.platforms) {
    perPlatform[p] = body.slice(0, PLATFORM_LIMITS[p].hard);
  }
  return [
    {
      title: trend.title,
      body,
      perPlatform,
      // Placeholder copy must never clear an auto-publish threshold — this is
      // canned marketing text, not something the user asked to be posted.
      // 0 is below every selectable threshold, so it always lands in review.
      score: 0,
      rationale: 'Placeholder draft — the model was unavailable, so this is boilerplate. Review before publishing.',
      trendId: trend.id,
    },
  ];
}
