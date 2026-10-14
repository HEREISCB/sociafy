import { z } from 'zod';
import { PLATFORMS, VOICE_TEMPLATES } from './db/schema';
import { GST_STATES, isValidGstin } from './billing/gst';
import { GOOGLE_FONTS, MUSIC_MOODS, VIDEO_STYLES } from './brand/kit';

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
    // Autopilot's per-platform copy and a mid-render approval (DraftVariant):
    // stripping them on save loses both.
    perPlatform: z.partialRecord(platform, z.string().max(20_000)).optional(),
    approved: z.boolean().optional(),
  })).max(20).optional(),
  selectedVariantLabel: z.string().max(80).nullable().optional(),
  media: z.array(z.object({
    id: id,
    url: z.string().url().max(2_000),
    mimeType: z.string().max(80),
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
  })).max(20).optional(),
  targetPlatforms: z.array(platform).max(7).optional(),
  // String-keyed record so missing platform keys are allowed. With
  // z.record(platform, ...), Zod 4 treats the enum as a closed set and
  // requires every platform key to be present — which broke persistDraft
  // any time the user picked only a subset of platforms.
  perPlatformText: z.record(z.string(), z.string().max(20_000)).optional(),
  preset: z.string().max(80).nullable().optional(),
});

export const draftUpdateSchema = draftCreateSchema.partial().extend({
  status: z.enum(['draft', 'scheduled', 'published', 'archived']).optional(),
  // Move a planned post. null = unplanned (approve picks the next free slot).
  plannedAt: z.string().datetime().nullable().optional(),
});

// Plan (weekly/monthly review) -------------------------------------------
const horizonDays = z.union([z.literal(7), z.literal(30)]);
export const planGenerateSchema = z.object({ horizonDays: horizonDays.optional() });
export const planApproveSchema = z.object({
  draftIds: z.array(uuid).min(1).max(100).optional(),
  all: z.literal(true).optional(),
  // draftId → ISO time. A time already past is re-slotted like any overdue draft.
  overrides: z.record(uuid, z.string().datetime()).optional(),
}).refine((b) => b.all || b.draftIds, { message: 'draftIds or all:true required' });
export const planSkipSchema = z.object({ draftId: uuid });

// Schedule -------------------------------------------------------------
export const scheduleCreateSchema = z.object({
  draftId: uuid,
  platforms: z.array(platform).min(1).max(7).optional(),
  scheduledAt: z.string().datetime(),
});

export const scheduleUpdateSchema = z.object({
  scheduledAt: z.string().datetime().optional(),
  status: z.enum(['pending', 'canceled']).optional(),
  text: z.string().max(20_000).optional(),
});

// Publish --------------------------------------------------------------
export const publishSchema = z.object({
  draftId: uuid,
  platforms: z.array(platform).min(1).max(7).optional(),
});

// Compose variants -----------------------------------------------------
export const composeVariantsSchema = z.object({
  prompt: z.string().min(1).max(4_000),
  // Allow empty array — route falls back to generating for all platforms.
  platforms: z.array(platform).max(7).default([]),
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
  // 101 is the "Drafts only — review every post" sentinel; the agent's
  // run loop treats anything > 100 as never-auto-publish. Keep that ceiling
  // in sync with components/autopilot/plan-settings.tsx if you ever change the magic value.
  autoPublishThreshold: z.number().int().min(0).max(101).optional(),
  quietHours: z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  }).optional(),
  brandSafetyStrict: z.boolean().optional(),
  // niches accept user-defined free-text values too (existing UX), not just the enum.
  niches: z.array(z.string().min(1).max(40)).max(40).optional(),
  voiceTemplate: z.enum(VOICE_TEMPLATES).optional(),
  trendSources: z.array(z.string().max(200)).max(20).optional(),
  // Brand profile — flows into every AI surface (image, video, text gen).
  companyName: z.string().max(120).optional(),
  brandBio: z.string().max(2_000).optional(),
  website: z.string().url().max(500).optional().or(z.literal('')),
  // Autopilot permission matrix.
  enabledPlatforms: z.array(platform).max(7).optional(),
  // partialRecord: Zod 4's z.record over an enum demands EVERY key, so caps for
  // just the platforms a user has (the only shape the UI ever sends) were a 400.
  postsPerWeekByPlatform: z.partialRecord(platform, z.number().int().min(0).max(50)).optional(),
  postsPerWeekByContentType: z.object({
    text: z.number().int().min(0).max(50),
    image: z.number().int().min(0).max(50),
    video: z.number().int().min(0).max(20),
  }).optional(),
  // null clears the cap.
  weeklyCreditCap: z.number().int().min(0).max(1_000_000).nullable().optional(),
  planHorizonDays: horizonDays.optional(),
});

// Brand kit ------------------------------------------------------------
// Every section optional; PATCH replaces whole top-level sections. Asset refs
// carry the mime so each slot can only hold its kind of file — the route
// re-reads id/url/mime from media_assets (ownership) and parses again.
const assetRef = (mime: RegExp) => z.object({
  id: uuid,
  url: z.string().url().max(2_000),
  mime: z.string().regex(mime),
  name: z.string().max(200).optional(),
});
const logoRef = assetRef(/^image\/(svg\+xml|png|webp|jpeg)$/);
const hex = z.string().regex(/^#[0-9a-f]{6}$/i);
const short = (max: number) => z.string().trim().min(1).max(max);
const fontChoice = z.discriminatedUnion('source', [
  z.object({ source: z.literal('google'), family: z.enum(GOOGLE_FONTS) }),
  z.object({
    source: z.literal('upload'),
    family: short(60),
    asset: assetRef(/^font\/(woff2|ttf|otf)$/),
    // The user's word that they may use this font in rendered videos.
    licensed: z.literal(true),
  }),
]);
export const brandKitSchema = z.object({
  tagline: z.string().trim().max(60).optional(),
  logo: z.object({ primary: logoRef, icon: logoRef, reversed: logoRef, mono: logoRef }).partial().optional(),
  colors: z.object({ primary: hex, secondary: hex, background: hex, text: hex, accent: hex }).partial().optional(),
  fonts: z.object({ display: fontChoice, body: fontChoice }).partial().optional(),
  voice: z.object({
    tone: z.array(short(30)).max(8),
    do: z.array(short(120)).max(10),
    dont: z.array(short(120)).max(10),
  }).partial().optional(),
  guidePdf: assetRef(/^application\/pdf$/).optional(),
  screenshots: z.array(assetRef(/^image\/(png|webp|jpeg)$/)).max(8).optional(),
  facts: z.array(short(140)).max(6).optional(),
  music: z.object({ mood: z.enum(MUSIC_MOODS), banned: z.string().trim().max(300) }).partial().optional(),
  video: z.object({ style: z.enum(VIDEO_STYLES), endCardCta: z.string().trim().max(40) }).partial().optional(),
  narratorVoiceId: uuid.optional(),
});
// PATCH body: sections replace stored ones; null clears the two scalar slots
// (arrays/objects/strings clear by sending them empty).
export const brandKitPatchSchema = brandKitSchema.extend({
  guidePdf: brandKitSchema.shape.guidePdf.nullable(),
  narratorVoiceId: uuid.nullable().optional(),
});

// Accounts -------------------------------------------------------------
export const stubAccountCreateSchema = z.object({
  platform: platform,
  handle: z.string().max(120).optional(),
});

// Billing / GST details ------------------------------------------------
/**
 * What goes on a tax invoice. Every field is optional so the user can save a
 * partial form and come back — but GSTIN and PAN are checked properly when
 * present. A malformed GSTIN does not fail loudly at save time; it fails
 * months later as an invoice naming a business that does not exist, which is
 * the customer's accountant's problem to unwind. Reject it here instead.
 */
export const billingDetailsSchema = z.object({
  legalName: z.string().max(200).optional(),
  gstin: z.string()
    .transform((v) => v.trim().toUpperCase())
    .refine((v) => v === '' || isValidGstin(v), 'Not a valid GSTIN — check for a typo.')
    .optional(),
  // PAN: 5 letters, 4 digits, 1 letter. No checksum exists for it.
  pan: z.string()
    .transform((v) => v.trim().toUpperCase())
    .refine((v) => v === '' || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v), 'Not a valid PAN.')
    .optional(),
  billingAddress: z.object({
    line1: z.string().max(200).optional(),
    line2: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    postalCode: z.string().max(20).optional(),
    country: z.string().length(2).optional(),
  }).optional(),
  /** 2-digit GST state code. '' clears it. */
  placeOfSupply: z.string()
    .refine((v) => v === '' || !!GST_STATES[v], 'Unknown state.')
    .optional(),
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
