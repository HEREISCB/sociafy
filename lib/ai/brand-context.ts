import { eq } from 'drizzle-orm';
import { db } from '../db';
import { agentSettings, brandKits, type Niche, type VoiceTemplate } from '../db/schema';
import type { BrandKit } from '../brand/kit';

/**
 * The user's brand profile assembled into a compact block we can drop
 * into any AI system prompt. Every field is optional — we only render
 * sections that are non-empty so users with sparse settings still get
 * useful (but generic) output.
 */
export type BrandContext = {
  companyName: string | null;
  brandBio: string | null;
  website: string | null;
  /** LLM summary of the website's own copy — see lib/ai/brand-brief.ts. */
  brandBrief: string | null;
  niches: Niche[];
  voiceTemplate: VoiceTemplate | null;
  /** The user's freeform style guide. Separate from brandBio: the bio
   *  says WHO they are; instructions say HOW the voice should sound. */
  instructions: string | null;
  brandSafetyStrict: boolean;
  /** Settings › Brand kit (tagline, voice, facts, colors…). Optional. */
  kit?: BrandKit | null;
};

/**
 * Fetch the brand context for a user. Returns null if the user has no
 * agent_settings row yet (e.g. they haven't touched onboarding). Callers
 * should treat that as "no extra context" and proceed with the loose
 * prompt + skill file alone.
 */
export async function loadBrandContext(userId: string): Promise<BrandContext | null> {
  const [settings] = await db()
    .select()
    .from(agentSettings)
    .where(eq(agentSettings.userId, userId))
    .limit(1);
  if (!settings) return null;
  const kit = await loadBrandKit(userId);
  return {
    companyName: settings.companyName,
    brandBio: settings.brandBio,
    website: settings.website,
    brandBrief: settings.brandBrief,
    niches: (settings.niches ?? []) as Niche[],
    voiceTemplate: (settings.voiceTemplate ?? null) as VoiceTemplate | null,
    instructions: settings.instructions || null,
    brandSafetyStrict: settings.brandSafetyStrict,
    kit,
  };
}

/**
 * The user's brand kit, or null. A failed read (e.g. drizzle/0019 not applied
 * yet) degrades to null: the kit only enriches prompts, and caption or image
 * generation must not fail because of it.
 */
export async function loadBrandKit(userId: string): Promise<BrandKit | null> {
  try {
    const [row] = await db().select({ kit: brandKits.kit }).from(brandKits).where(eq(brandKits.userId, userId)).limit(1);
    return row?.kit ?? null;
  } catch (e) {
    console.warn('[brand-kit] load failed:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Render the brand context as a system-prompt block. Returns '' if the
 * user has filled in nothing — empty string is safe to concatenate, so
 * callers don't need to gate on null.
 *
 * The block is intentionally compact: AIs degrade when system prompts
 * balloon, and we want this to sit next to a skill file without crowding
 * out the actual task instructions.
 *
 * @param mode - 'media' for image/video rewriters (skips voice template
 *   since visual models don't reason about prose tone), 'text' for caption
 *   generation (includes voice).
 */
export function renderBrandBlock(ctx: BrandContext | null, mode: 'media' | 'text'): string {
  if (!ctx) return '';
  const lines: string[] = [];
  const kit = ctx.kit ?? {};
  if (ctx.companyName) lines.push(`Brand: ${ctx.companyName}`);
  if (kit.tagline) lines.push(`Tagline: ${kit.tagline}`);
  if (ctx.brandBio) lines.push(`About: ${ctx.brandBio}`);
  if (ctx.website) lines.push(`Website: ${ctx.website}`);
  if (ctx.brandBrief) lines.push(`From their website: ${ctx.brandBrief}`);
  if (ctx.niches.length) lines.push(`Niches: ${ctx.niches.join(', ')}`);
  if (mode === 'text') {
    if (ctx.voiceTemplate) lines.push(`Voice preset: ${ctx.voiceTemplate}`);
    if (ctx.instructions) lines.push(`Style guide: ${ctx.instructions}`);
    if (kit.voice?.tone?.length) lines.push(`Tone: ${kit.voice.tone.join(', ')}`);
    if (kit.voice?.do?.length) lines.push(`Say things like: ${kit.voice.do.join(' | ')}`);
    if (kit.voice?.dont?.length) lines.push(`Never say: ${kit.voice.dont.join(' | ')}`);
    if (kit.facts?.length) lines.push(`Approved brand facts (cite only these for stats or claims about the brand): ${kit.facts.join(' | ')}`);
  } else {
    const c = kit.colors ?? {};
    const colors = (['primary', 'secondary', 'accent', 'background'] as const).filter((k) => c[k]).map((k) => `${k} ${c[k]}`);
    if (colors.length) lines.push(`Brand colors: ${colors.join(', ')}`);
  }
  if (ctx.brandSafetyStrict) lines.push('Brand safety: strict. Avoid controversial claims, profanity, political takes, or anything that could embarrass the brand.');
  if (lines.length === 0) return '';
  return [
    '--- Brand context ---',
    ...lines,
    '--- end brand context ---',
  ].join('\n');
}
