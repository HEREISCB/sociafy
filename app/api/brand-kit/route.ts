import { NextRequest } from 'next/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { withUser } from '../../../lib/api';
import { db } from '../../../lib/db';
import { agentSettings, brandKits, mediaAssets } from '../../../lib/db/schema';
import { brandKitPatchSchema, parseBody } from '../../../lib/validation';
import { brandKitCompleteness, type BrandKit, type BrandProfile } from '../../../lib/brand/kit';
import { motionConfigured } from '../../../lib/ai/motion';
import { motionAiConfigured } from '../../../lib/ai/motionAi';

export const runtime = 'nodejs';

/**
 * GET   /api/brand-kit → { kit, profile, brandKitCompleteness, motion, motionAi }
 * PATCH /api/brand-kit   body: any subset of BrandKit's top-level sections;
 *                        each one sent replaces the stored section (null clears
 *                        guidePdf / narratorVoiceId). Returns the GET shape.
 *
 * `profile` (name, bio, website, style guide) is read-only here — it lives on
 * agent_settings and is written through PATCH /api/agent/settings, which also
 * rebuilds the website brief.
 */
async function load(userId: string) {
  const [[k], [s]] = await Promise.all([
    db().select({ kit: brandKits.kit }).from(brandKits).where(eq(brandKits.userId, userId)).limit(1),
    db()
      .select({
        companyName: agentSettings.companyName,
        brandBio: agentSettings.brandBio,
        website: agentSettings.website,
        instructions: agentSettings.instructions,
      })
      .from(agentSettings)
      .where(eq(agentSettings.userId, userId))
      .limit(1),
  ]);
  const kit: BrandKit = k?.kit ?? {};
  const profile: BrandProfile = s ?? { companyName: null, brandBio: null, website: null, instructions: null };
  // `motion` / `motionAi`: the template and AI-designed motion-graphics feature
  // flags, so client surfaces can hide what isn't configured.
  return { kit, profile, brandKitCompleteness: brandKitCompleteness(kit, profile), motion: motionConfigured(), motionAi: motionAiConfigured() };
}

export async function GET(req: NextRequest) {
  return withUser((user) => load(user.id), req);
}

type Asset = { id: string; url: string; mime: string; name?: string };
const isAsset = (v: unknown): v is Asset =>
  !!v && typeof v === 'object' && typeof (v as Asset).id === 'string' && typeof (v as Asset).mime === 'string';

/** Every asset ref in a value, at any depth. */
function collect(v: unknown, out: Asset[] = []): Asset[] {
  if (isAsset(v)) out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collect(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => collect(x, out));
  return out;
}

/** Replace each asset ref's url/mime with the stored row's (dropping refs the
 *  user doesn't own), so a client can't point the kit at arbitrary URLs. */
function rewrite(v: unknown, owned: Map<string, { url: string; mime: string }>): unknown {
  if (isAsset(v)) {
    const row = owned.get(v.id);
    return row ? { id: v.id, url: row.url, mime: row.mime, ...(v.name && { name: v.name }) } : undefined;
  }
  if (Array.isArray(v)) return v.map((x) => rewrite(x, owned)).filter((x) => x !== undefined);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, rewrite(x, owned)]).filter(([, x]) => x !== undefined));
  }
  return v;
}

export async function PATCH(req: NextRequest) {
  return withUser(async (user) => {
    const first = parseBody(brandKitPatchSchema, await req.json().catch(() => ({})));
    if (!first.ok) return first.response;

    const ids = [...new Set(collect(first.data).map((a) => a.id))];
    const rows = ids.length
      ? await db()
          .select({ id: mediaAssets.id, url: mediaAssets.publicUrl, mime: mediaAssets.mimeType })
          .from(mediaAssets)
          .where(and(eq(mediaAssets.userId, user.id), inArray(mediaAssets.id, ids)))
      : [];
    // Parse again: the stored mime must also fit the slot (a PDF can't become a logo).
    const second = parseBody(brandKitPatchSchema, rewrite(first.data, new Map(rows.map((r) => [r.id, r]))));
    if (!second.ok) return second.response;

    // Top-level merge in SQL so two rows autosaving at once can't drop each other's edit.
    const patch = JSON.stringify(second.data);
    await db()
      .insert(brandKits)
      .values({ userId: user.id, kit: sql`jsonb_strip_nulls(${patch}::jsonb)` })
      .onConflictDoUpdate({
        target: brandKits.userId,
        set: { kit: sql`jsonb_strip_nulls(${brandKits.kit} || ${patch}::jsonb)`, updatedAt: new Date() },
      });
    return load(user.id);
  }, req);
}
