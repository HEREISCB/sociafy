import type { z } from 'zod';
import type { brandKitSchema } from '../validation';

/**
 * Brand kit: everything a user tells us about their brand, item by item.
 * Stored in brand_kits.kit (drizzle/0019), validated by brandKitSchema.
 * Brand name, bio ("what you do"), website and the free-text style guide are
 * NOT in here — they stay on agent_settings (companyName, brandBio, website,
 * instructions), which the brand-brief builder and every prompt already read.
 *
 * Pure module: safe to import from client components and tests.
 */
export type BrandKit = z.infer<typeof brandKitSchema>;
export type AssetRef = { id: string; url: string; mime: string; name?: string };
export type FontChoice = NonNullable<NonNullable<BrandKit['fonts']>['display']>;

/** The agent_settings half of the brand, as GET /api/brand-kit returns it. */
export type BrandProfile = {
  companyName: string | null;
  brandBio: string | null;
  website: string | null;
  instructions: string | null;
};

// Every curated family ships 400 and 700 on Google Fonts — googleFontCssUrl asks for both.
export const GOOGLE_FONTS = [
  'Inter', 'DM Sans', 'Manrope', 'Space Grotesk', 'Poppins', 'Montserrat',
  'Work Sans', 'Archivo', 'Playfair Display', 'Fraunces', 'Lora', 'Libre Baskerville',
] as const;
export const MUSIC_MOODS = ['calm', 'upbeat', 'cinematic', 'none'] as const;
export const VIDEO_STYLES = ['soft', 'bold'] as const;
/** What autopilot video slots render as (brand_kits.kit.video.autopilot; unset = cinema).
 *  'cinema' is a legacy stored id meaning "generated AI clip" (shown as "AI video"),
 *  not the Cinema model — autopilot renders it on DEFAULT_VIDEO_MODEL. */
export const AUTOPILOT_VIDEO_STYLES = ['cinema', 'motion', 'mix'] as const;
export type AutopilotVideoStyle = (typeof AUTOPILOT_VIDEO_STYLES)[number];
export const COLOR_ROLES = ['primary', 'secondary', 'background', 'text', 'accent'] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

export const DEFAULT_FONT = 'Inter';

export function googleFontCssUrl(family: string): string {
  return `https://fonts.googleapis.com/css2?family=${family.trim().replace(/ /g, '+')}:wght@400;700&display=swap`;
}

// ---- Color ---------------------------------------------------------------

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
/** a → b by t (0..1), in sRGB. Good enough for tints and shades. */
const mix = (a: string, b: string, t: number) => {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
};

/** WCAG 2 contrast ratio between two #rrggbb colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = rgb(hex).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const INK = '#111111';
const PAPER = '#FFFFFF';

/** All five roles, filling gaps from primary: secondary = deeper shade,
 *  background = faint tint, text = whichever of ink/paper reads on the
 *  background, accent = secondary. No primary at all → near-black. */
export function resolveColors(c: BrandKit['colors'] = {}): Record<ColorRole, string> {
  const primary = c.primary ?? INK;
  const secondary = c.secondary ?? mix(primary, '#000000', 0.35);
  const background = c.background ?? (c.primary ? mix(primary, PAPER, 0.94) : PAPER);
  const text = c.text ?? (contrastRatio(INK, background) >= contrastRatio(PAPER, background) ? INK : PAPER);
  const accent = c.accent ?? secondary;
  return { primary: primary.toUpperCase(), secondary: secondary.toUpperCase(), background: background.toUpperCase(), text: text.toUpperCase(), accent: accent.toUpperCase() };
}

// ---- Completeness --------------------------------------------------------

export const CHECKLIST = [
  'identity', 'logo', 'colors', 'fonts', 'voice', 'guide',
  'screenshots', 'facts', 'music', 'video', 'narrator',
] as const;
export type ChecklistItem = (typeof CHECKLIST)[number];

export type Completeness = { done: number; total: number; items: Record<ChecklistItem, boolean> };

export function brandKitCompleteness(kit: BrandKit, profile: Pick<BrandProfile, 'companyName'>): Completeness {
  const items: Record<ChecklistItem, boolean> = {
    identity: !!profile.companyName?.trim(),
    logo: !!kit.logo?.primary,
    colors: !!kit.colors?.primary,
    fonts: !!(kit.fonts?.display || kit.fonts?.body),
    voice: !!(kit.voice?.tone?.length || kit.voice?.do?.length || kit.voice?.dont?.length),
    guide: !!kit.guidePdf,
    screenshots: !!kit.screenshots?.length,
    facts: !!kit.facts?.length,
    music: !!kit.music?.mood,
    video: !!kit.video?.style,
    narrator: !!kit.narratorVoiceId,
  };
  return { done: Object.values(items).filter(Boolean).length, total: CHECKLIST.length, items };
}

// ---- Motion template variables -------------------------------------------

/**
 * What a motion-graphics (HyperFrames) template receives. Every field is
 * always present; missing kit items fall back as noted.
 *
 * {
 *   brandName: string           // agent_settings.companyName, '' if unset
 *   tagline: string             // ≤ 60 chars, '' if unset
 *   cta: string                 // end-card text; else website host; else ''
 *   ctaUrl: string              // agent_settings.website, '' if unset
 *   colors: { primary, secondary, background, text, accent }
 *                               // '#RRGGBB'; gaps derived from primary (resolveColors)
 *   fontDisplay: string         // CSS family name, default 'Inter'
 *   fontBody: string            // CSS family name, default 'Inter'
 *   fontDisplayUrl: string      // Google Fonts css2 stylesheet URL (https://fonts.googleapis.com/…)
 *   fontBodyUrl: string         //   → <link>; otherwise a .woff2/.ttf/.otf file URL → @font-face
 *   logoUrl: string | null      // primary logo (SVG or PNG)
 *   logoReverseUrl: string|null // for dark backgrounds: reversed, else mono; null → put logoUrl on a light plate
 *   logoIconUrl: string | null  // square mark, else null
 *   facts: string[]             // ≤ 6 user-approved lines — the ONLY claims a template may show
 *   screenshots: string[]       // ≤ 8 image URLs, user order
 *   musicMood: 'calm' | 'upbeat' | 'cinematic' | 'none'   // default 'calm'
 *   style: 'soft' | 'bold'      // default 'soft'
 * }
 */
export type BrandVariables = {
  brandName: string;
  tagline: string;
  cta: string;
  ctaUrl: string;
  colors: Record<ColorRole, string>;
  fontDisplay: string;
  fontBody: string;
  fontDisplayUrl: string;
  fontBodyUrl: string;
  logoUrl: string | null;
  logoReverseUrl: string | null;
  logoIconUrl: string | null;
  facts: string[];
  screenshots: string[];
  musicMood: (typeof MUSIC_MOODS)[number];
  style: (typeof VIDEO_STYLES)[number];
};

const font = (f: FontChoice | undefined) =>
  f?.source === 'upload'
    ? { family: f.family, url: f.asset.url }
    : { family: f?.family ?? DEFAULT_FONT, url: googleFontCssUrl(f?.family ?? DEFAULT_FONT) };

const host = (url: string) => {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; }
};

export function brandVariables(
  kit: BrandKit,
  profile: Partial<Pick<BrandProfile, 'companyName' | 'website'>> = {},
): BrandVariables {
  const website = profile.website?.trim() ?? '';
  const display = font(kit.fonts?.display);
  // Body falls back to the display face before the default: one chosen font beats two mismatched ones.
  const body = kit.fonts?.body ? font(kit.fonts.body) : display;
  return {
    brandName: profile.companyName?.trim() ?? '',
    tagline: kit.tagline ?? '',
    cta: kit.video?.endCardCta || host(website),
    ctaUrl: website,
    colors: resolveColors(kit.colors),
    fontDisplay: display.family,
    fontBody: body.family,
    fontDisplayUrl: display.url,
    fontBodyUrl: body.url,
    logoUrl: kit.logo?.primary?.url ?? null,
    logoReverseUrl: kit.logo?.reversed?.url ?? kit.logo?.mono?.url ?? null,
    logoIconUrl: kit.logo?.icon?.url ?? null,
    facts: kit.facts ?? [],
    screenshots: (kit.screenshots ?? []).map((s) => s.url),
    musicMood: kit.music?.mood ?? 'calm',
    style: kit.video?.style ?? 'soft',
  };
}

/** Enough of a kit for a motion graphic to look like the brand: name, logo, primary color. */
export function motionReady(kit: BrandKit, profile: Partial<Pick<BrandProfile, 'companyName'>>): boolean {
  return !!profile.companyName?.trim() && !!kit.logo?.primary && !!kit.colors?.primary;
}

/**
 * brandVariables + generated copy → the motion template variables
 * (motion/README.md). No font chosen → '' so templates keep their bundled
 * faces instead of brandVariables' Inter default.
 */
export function motionVariables(
  kit: BrandKit,
  profile: Partial<Pick<BrandProfile, 'companyName' | 'website'>>,
  copy: { hook: string; lines: string[]; facts: string[] },
) {
  const brand = brandVariables(kit, profile);
  return {
    ...brand,
    fontDisplayUrl: kit.fonts?.display ? brand.fontDisplayUrl : '',
    fontBodyUrl: kit.fonts?.display || kit.fonts?.body ? brand.fontBodyUrl : '',
    hook: copy.hook,
    lines: copy.lines,
    facts: copy.facts.length ? copy.facts : brand.facts,
  };
}
