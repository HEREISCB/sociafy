import { eq } from 'drizzle-orm';
import { db } from '../db';
import { agentSettings, type Niche, type VoiceTemplate } from '../db/schema';

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
  niches: Niche[];
  voiceTemplate: VoiceTemplate | null;
  /** The user's freeform style guide. Separate from brandBio: the bio
   *  says WHO they are; instructions say HOW the voice should sound. */
  instructions: string | null;
  brandSafetyStrict: boolean;
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
  return {
    companyName: settings.companyName,
    brandBio: settings.brandBio,
    website: settings.website,
    niches: (settings.niches ?? []) as Niche[],
    voiceTemplate: (settings.voiceTemplate ?? null) as VoiceTemplate | null,
    instructions: settings.instructions || null,
    brandSafetyStrict: settings.brandSafetyStrict,
  };
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
  if (ctx.companyName) lines.push(`Brand: ${ctx.companyName}`);
  if (ctx.brandBio) lines.push(`About: ${ctx.brandBio}`);
  if (ctx.website) lines.push(`Website: ${ctx.website}`);
  if (ctx.niches.length) lines.push(`Niches: ${ctx.niches.join(', ')}`);
  if (mode === 'text') {
    if (ctx.voiceTemplate) lines.push(`Voice preset: ${ctx.voiceTemplate}`);
    if (ctx.instructions) lines.push(`Style guide: ${ctx.instructions}`);
  }
  if (ctx.brandSafetyStrict) lines.push('Brand safety: strict — avoid controversial claims, profanity, political takes, or anything that could embarrass the brand.');
  if (lines.length === 0) return '';
  return [
    '--- Brand context ---',
    ...lines,
    '--- end brand context ---',
  ].join('\n');
}
