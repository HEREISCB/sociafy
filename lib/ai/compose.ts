import { getAnthropic, MODELS } from './client';
import { type Platform, type DraftVariant, type VoiceTemplate } from '../db/schema';

const VOICE_HINTS: Record<VoiceTemplate, string> = {
  me: 'Adapt to the writer\'s natural voice as inferred from their prompt. Conversational, with a clear point of view.',
  punchy: 'Punchy and bold. Short sentences. Strong opener. No filler.',
  thoughtful: 'Considered and reflective. Earns the reader\'s attention. Specific examples over abstractions.',
  'data-led': 'Lead with a specific number or data point. Cite sources when possible. Quantitative throughout.',
};

export const PLATFORM_LIMITS: Record<Platform, { hard: number; sweet: [number, number]; notes: string }> = {
  x: { hard: 280, sweet: [120, 240], notes: 'Hooks in the first line. No hashtag spam. Threads OK if needed.' },
  linkedin: { hard: 3000, sweet: [600, 1500], notes: 'Professional but human. Whitespace between paragraphs. Lead with a story or stat.' },
  instagram: { hard: 2200, sweet: [80, 220], notes: 'Caption supports the visual. Hooky first line. Hashtags at end if relevant.' },
  facebook: { hard: 2000, sweet: [100, 400], notes: 'Conversational. Encourage reply or reaction.' },
  tiktok: { hard: 2200, sweet: [40, 150], notes: 'Caption hook for the video. Punchy. Question or claim that begs a watch.' },
  youtube: { hard: 5000, sweet: [200, 800], notes: 'Title-style hook then context. Mention what the viewer learns. Add chapter cues if helpful.' },
};

export type ComposePresetKey = 'thread' | 'announcement' | 'recap' | 'hot-take' | 'lesson' | 'reel';

const PRESET_BLURBS: Record<ComposePresetKey, string> = {
  thread: 'Multi-post structure. Hook + 4–6 supporting beats + closer. Each beat a complete thought.',
  announcement: 'A clear, exciting reveal. What it is, who it\'s for, why now. Soft call to action at the end.',
  recap: 'A specific takeaway from a moment, week, or project. Numbers when available. Lessons over hype.',
  'hot-take': 'A pointed, defensible opinion. Stake a claim in the first sentence. Back it with reasoning.',
  lesson: 'Something learned the hard way, written so the reader doesn\'t have to repeat the mistake.',
  reel: 'A short script. 1–2 lines hook, 2–3 lines payoff. Visual cues in brackets if helpful.',
};

export type ComposeArgs = {
  prompt: string;
  voiceTemplate?: VoiceTemplate;
  preset?: ComposePresetKey;
  platforms?: Platform[];
  count?: number;
  agentInstructions?: string;
};

export type ComposeResult = {
  variants: DraftVariant[];
  perPlatform: Partial<Record<Platform, string>>;
  stub: boolean;
};

export async function generateCompose(args: ComposeArgs): Promise<ComposeResult> {
  const count = Math.min(args.count ?? 4, 4);
  const platforms = args.platforms?.length ? args.platforms : (['x', 'linkedin'] as Platform[]);

  const anthropic = getAnthropic();
  if (!anthropic) {
    return stubResult(args.prompt, count, platforms);
  }

  const voice = VOICE_HINTS[args.voiceTemplate ?? 'me'];
  const preset = args.preset ? PRESET_BLURBS[args.preset] : 'A focused single post.';

  const sys = [
    'You are a social media copy partner for a solo founder.',
    `Voice: ${voice}`,
    `Format: ${preset}`,
    args.agentInstructions
      ? `User\'s style guide:\n${args.agentInstructions}`
      : '',
    'Output rules:',
    '- Return STRICT JSON. No markdown fences. No commentary.',
    `- Schema: { "variants": [ { "label": "A"|"B"|"C"|"D", "text": string, "score": 0-100, "rationale": string } ], "perPlatform": { "x": string, "linkedin": string, "instagram": string, "facebook": string, "tiktok": string, "youtube": string } }`,
    `- Provide ${count} variants. Distinct angles. Score reflects strength of hook + clarity + on-brand fit.`,
    `- For each requested platform (${platforms.join(', ')}), adapt the strongest variant to that platform\'s norms.`,
    '- Platform constraints:',
    ...platforms.map((p) => `  - ${p}: ${PLATFORM_LIMITS[p].notes} Stay under ${PLATFORM_LIMITS[p].hard} chars; aim for ${PLATFORM_LIMITS[p].sweet[0]}–${PLATFORM_LIMITS[p].sweet[1]}.`),
  ].filter(Boolean).join('\n');

  const user = `Write social posts about:\n\n"""${args.prompt}"""`;

  const resp = await anthropic.messages.create({
    model: MODELS.fast,
    max_tokens: 1500,
    system: sys,
    messages: [{ role: 'user', content: user }],
  });

  const text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('')
    .trim();

  let parsed: { variants: DraftVariant[]; perPlatform: Partial<Record<Platform, string>> };
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return stubResult(args.prompt, count, platforms);
  }

  return {
    variants: (parsed.variants ?? []).slice(0, count).map((v, i) => ({
      label: v.label || ['A', 'B', 'C', 'D'][i] || `V${i + 1}`,
      text: v.text ?? '',
      score: typeof v.score === 'number' ? clampScore(v.score) : undefined,
      rationale: v.rationale,
    })),
    perPlatform: parsed.perPlatform ?? {},
    stub: false,
  };
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function clampScore(n: number) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function stubResult(prompt: string, count: number, platforms: Platform[]): ComposeResult {
  const seed = (prompt || 'New post').slice(0, 80);
  const angles = [
    { label: 'A', text: `${seed}\n\nHere\'s the part nobody talks about — and why it matters this week.`, score: 86, rationale: 'Hook with a curiosity gap. Strong for X.' },
    { label: 'B', text: `Three things I\'ve been thinking about ${seed.toLowerCase()}:\n\n1. Speed beats planning\n2. Distribution > craft\n3. Boring is undefeated`, score: 79, rationale: 'List format, scannable. Good for LinkedIn.' },
    { label: 'C', text: `Hot take: ${seed} is overrated.\n\nWhat actually moves the needle for solo founders is shipping 3 small things a week.`, score: 91, rationale: 'Punchy contrarian framing.' },
    { label: 'D', text: `I tried ${seed} for 30 days. Here\'s what changed — and what didn\'t.`, score: 74, rationale: 'Personal narrative. Works as a thread starter.' },
  ].slice(0, count);

  const perPlatform: Partial<Record<Platform, string>> = {};
  const best = angles[0];
  for (const p of platforms) {
    perPlatform[p] = adaptForPlatform(best.text, p);
  }
  return { variants: angles, perPlatform, stub: true };
}

function adaptForPlatform(text: string, p: Platform): string {
  const limit = PLATFORM_LIMITS[p].hard;
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1) + '…';
}
