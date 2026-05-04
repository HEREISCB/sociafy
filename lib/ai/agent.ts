import { getAnthropic, MODELS } from './client';
import type { Niche, Platform, VoiceTemplate } from '../db/schema';
import { PLATFORM_LIMITS } from './compose';

export type AgentDraft = {
  title: string;
  body: string;
  perPlatform: Partial<Record<Platform, string>>;
  score: number;
  rationale: string;
  trendId?: string;
};

export type DraftAgentArgs = {
  instructions: string;
  voiceTemplate: VoiceTemplate;
  niches: Niche[];
  platforms: Platform[];
  brandSafetyStrict: boolean;
  trends: Array<{ id: string; niche: string; title: string; summary?: string | null; sourceUrl?: string | null }>;
  count: number;
};

export async function draftFromTrends(args: DraftAgentArgs): Promise<AgentDraft[]> {
  const anthropic = getAnthropic();
  if (!anthropic) return stubDrafts(args);

  const sys = [
    'You are an autonomous social media agent for a solo founder.',
    `Their style guide:\n${args.instructions}`,
    `Voice template: ${args.voiceTemplate}`,
    `Niches they post about: ${args.niches.join(', ') || 'general'}`,
    `Brand safety: ${args.brandSafetyStrict ? 'strict — refuse posts that mention competitors negatively, unverified claims, or sensitive topics' : 'standard'}`,
    'Output rules:',
    '- Return STRICT JSON. No markdown fences. No commentary.',
    '- Schema: { "drafts": [ { "title": string, "body": string, "perPlatform": { ... }, "score": 0-100, "rationale": string, "trendId": string | null } ] }',
    `- Produce ${args.count} drafts. Each tied to a different trend if possible.`,
    `- Score reflects: hook strength, on-brand fit, novelty. ≥ 90 means safe to auto-publish.`,
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

  const resp = await anthropic.messages.create({
    model: MODELS.smart,
    max_tokens: 2500,
    system: sys,
    messages: [{ role: 'user', content: user }],
  });
  const text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('')
    .trim();

  let parsed: { drafts: AgentDraft[] };
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return stubDrafts(args);
  }
  return (parsed.drafts ?? []).slice(0, args.count);
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
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
      score: 88,
      rationale: 'Stub — reflects the trend with a founder-first angle.',
      trendId: trend.id,
    },
  ];
}
