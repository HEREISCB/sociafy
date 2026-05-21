import { z } from 'zod';
import { PLATFORMS, VOICE_TEMPLATES } from './db/schema';

/**
 * Shared schemas for request body validation.
 *
 * All caps are deliberately generous but bounded — they exist to stop a
 * malicious or buggy client from streaming megabytes of JSON into Postgres,
 * not to enforce product limits (the platform-specific char limits are
 * enforced in lib/ai/compose.ts and the UI). Length-capping at the API
 * boundary is the cheapest defense against accidental DoS.
 */

const platform = z.enum(PLATFORMS);
export const platformSchema = platform;

const id = z.string().min(1).max(128);
const uuid = z.string().uuid();

// Drafts ---------------------------------------------------------------
export const draftCreateSchema = z.object({
  title: z.string().max(280).nullable().optional(),
  prompt: z.string().max(4_000).nullable().optional(),
  body: z.string().max(20_000).default(''),
  variants: z.array(z.object({
    label: z.string().max(80),
    text: z.string().max(20_000),
    score: z.number().optional(),
    rationale: z.string().max(2_000).optional(),
  })).max(20).optional(),
  selectedVariantLabel: z.string().max(80).nullable().optional(),
  media: z.array(z.object({
    id: id,
    url: z.string().url().max(2_000),
    mimeType: z.string().max(80),
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
  })).max(20).optional(),
  targetPlatforms: z.array(platform).max(6).optional(),
  // String-keyed record so missing platform keys are allowed. With
  // z.record(platform, ...), Zod 4 treats the enum as a closed set and
  // requires every platform key to be present — which broke persistDraft
  // any time the user picked only a subset of platforms.
  perPlatformText: z.record(z.string(), z.string().max(20_000)).optional(),
  preset: z.string().max(80).nullable().optional(),
});

export const draftUpdateSchema = draftCreateSchema.partial().extend({
  status: z.enum(['draft', 'scheduled', 'published', 'archived']).optional(),
});

// Schedule -------------------------------------------------------------
export const scheduleCreateSchema = z.object({
  draftId: uuid,
  platforms: z.array(platform).min(1).max(6).optional(),
  scheduledAt: z.string().datetime(),
  text: z.string().max(20_000).optional(),
});

export const scheduleUpdateSchema = z.object({
  scheduledAt: z.string().datetime().optional(),
  status: z.enum(['pending', 'canceled']).optional(),
  text: z.string().max(20_000).optional(),
});

// Publish --------------------------------------------------------------
export const publishSchema = z.object({
  draftId: uuid,
  platforms: z.array(platform).min(1).max(6).optional(),
});

// Compose variants -----------------------------------------------------
export const composeVariantsSchema = z.object({
  prompt: z.string().min(1).max(4_000),
  // Allow empty array — route falls back to generating for all platforms.
  platforms: z.array(platform).max(6).default([]),
  preset: z.string().max(80).nullable().optional(),
  voice: z.enum(VOICE_TEMPLATES).optional(),
  count: z.number().int().min(1).max(6).optional(),
  // Opt-in: agent gets web search + url fetch + recent-posts tools.
  withTools: z.boolean().optional(),
});

// Agent settings -------------------------------------------------------
export const agentSettingsUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  instructions: z.string().max(4_000).optional(),
  cadencePerWeek: z.number().int().min(0).max(50).optional(),
  autoPublishThreshold: z.number().int().min(0).max(100).optional(),
  quietHours: z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  }).optional(),
  brandSafetyStrict: z.boolean().optional(),
  // niches accept user-defined free-text values too (existing UX), not just the enum.
  niches: z.array(z.string().min(1).max(40)).max(40).optional(),
  voiceTemplate: z.enum(VOICE_TEMPLATES).optional(),
  trendSources: z.array(z.string().max(200)).max(20).optional(),
});

// Accounts -------------------------------------------------------------
export const stubAccountCreateSchema = z.object({
  platform: platform,
  handle: z.string().max(120).optional(),
});

/**
 * Parse a body or throw a typed error. Returns the parsed object on success,
 * or a Response on failure that the caller can return directly.
 */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown):
  | { ok: true; data: T }
  | { ok: false; response: Response } {
  const r = schema.safeParse(body);
  if (r.success) return { ok: true, data: r.data };
  // Don't leak exact field paths in production — they're often enough for
  // enumeration. Dev still gets the full Zod issue list to debug.
  const issues = r.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), msg: i.message }));
  return {
    ok: false,
    response: new Response(
      JSON.stringify({ error: 'invalid_body', issues: process.env.NODE_ENV === 'production' ? undefined : issues }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ),
  };
}
