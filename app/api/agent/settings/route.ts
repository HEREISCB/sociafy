import { NextRequest, after } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { withUser } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { agentSettings, activityLog, profiles } from '../../../../lib/db/schema';
import { agentSettingsUpdateSchema, parseBody } from '../../../../lib/validation';
import { buildBrandBrief } from '../../../../lib/ai/brand-brief';
import { refreshTrendsForUser } from '../../../../lib/cron/trends';
import { runAgentForUser } from '../../../../lib/agent/run';

// Bounds the `after()` work: the brand-brief build (2 fetch rounds at 10s + a
// 30s LLM call) or autopilot's first draft on enable.
export const maxDuration = 60;

const DEFAULT_INSTRUCTIONS = `Match my voice. Don't use emojis unless I do. Avoid hyperbole and corporate jargon. Lead with a clear point of view. When sharing data, cite the source. Hold posts that mention competitors or unverified claims for review.`;

async function ensureSettings(userId: string) {
  const [existing] = await db().select().from(agentSettings).where(eq(agentSettings.userId, userId)).limit(1);
  if (existing) return existing;
  const [created] = await db()
    .insert(agentSettings)
    .values({
      userId,
      instructions: DEFAULT_INSTRUCTIONS,
    })
    .returning();
  return created;
}

export async function GET() {
  return withUser(async (user) => ensureSettings(user.id));
}

export async function PATCH(req: NextRequest) {
  return withUser(async (user) => {
    const current = await ensureSettings(user.id);
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(agentSettingsUpdateSchema, raw);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const patch: Partial<typeof agentSettings.$inferInsert> = { updatedAt: new Date() };
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.instructions !== undefined) patch.instructions = body.instructions;
    if (body.cadencePerWeek !== undefined) patch.cadencePerWeek = body.cadencePerWeek;
    if (body.autoPublishThreshold !== undefined) patch.autoPublishThreshold = body.autoPublishThreshold;
    if (body.quietHours !== undefined) patch.quietHours = body.quietHours;
    if (body.brandSafetyStrict !== undefined) patch.brandSafetyStrict = body.brandSafetyStrict;
    if (body.niches !== undefined) {
      // niches is typed as Niche[] in the schema but the column is jsonb;
      // we accept user-defined free-text values too, so cast through.
      patch.niches = body.niches
        .map((n) => n.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40))
        .filter((n) => n.length > 0) as typeof patch.niches;
    }
    if (body.voiceTemplate !== undefined) patch.voiceTemplate = body.voiceTemplate;
    if (body.companyName !== undefined) patch.companyName = body.companyName || null;
    if (body.brandBio !== undefined) patch.brandBio = body.brandBio || null;
    if (body.website !== undefined) {
      patch.website = body.website || null;
      if (!patch.website) {
        patch.brandBrief = null;
        patch.brandBriefSource = null;
      }
    }
    if (body.enabledPlatforms !== undefined) patch.enabledPlatforms = body.enabledPlatforms;
    if (body.postsPerWeekByPlatform !== undefined) patch.postsPerWeekByPlatform = body.postsPerWeekByPlatform;
    if (body.postsPerWeekByContentType !== undefined) {
      patch.postsPerWeekByContentType = body.postsPerWeekByContentType;
      // The mix is the plan; keep the legacy column in step for anything still reading it.
      const { text, image, video } = body.postsPerWeekByContentType;
      if (text + image + video > 0) patch.cadencePerWeek = text + image + video;
    }
    if (body.weeklyCreditCap !== undefined) patch.weeklyCreditCap = body.weeklyCreditCap;
    const [row] = await db()
      .update(agentSettings)
      .set(patch)
      .where(eq(agentSettings.userId, user.id))
      .returning();

    if (body.enabled !== undefined && body.enabled !== current.enabled) {
      await db().insert(activityLog).values({
        userId: user.id,
        kind: body.enabled ? 'agent_enabled' : 'agent_disabled',
        title: body.enabled ? 'Autopilot enabled' : 'Autopilot disabled',
        meta: {},
      });
    }

    // Switching on — or fixing what had it stuck (niches, platforms) — should
    // produce something now, not at the next 2-hourly tick. Unforced on purpose:
    // pacing, the credit cap and the run claim all still apply, so toggling
    // settings cannot farm drafts.
    const turnedOn = body.enabled === true && !current.enabled;
    if (row.enabled && (turnedOn || body.niches !== undefined || body.enabledPlatforms !== undefined)) {
      after(async () => {
        try {
          await refreshTrendsForUser(user.id, (row.niches ?? []) as string[]);
          await runAgentForUser(user.id);
        } catch (e) {
          console.error('[autopilot] kick failed:', e instanceof Error ? e.message : String(e));
        }
      });
    }

    // Mark profile as onboarded on first save only (idempotent). Gates the
    // /onboarding redirect — once set, /onboarding sends them to /dashboard.
    await db()
      .update(profiles)
      .set({ onboardedAt: new Date() })
      .where(and(eq(profiles.id, user.id), isNull(profiles.onboardedAt)));
    // Cover the rare case where the profile row doesn't exist yet (Clerk
    // webhook usually creates it on signup but it could lag).
    await db()
      .insert(profiles)
      .values({ id: user.id, onboardedAt: new Date() })
      .onConflictDoNothing({ target: profiles.id });

    // Read the website into a brand brief after the response — a slow or dead
    // site must never slow down or fail the save. Stale = the URL changed since
    // the brief was built, or a previous build failed and left it null.
    const site = row.website;
    if (body.website !== undefined && site && (site !== row.brandBriefSource || !row.brandBrief)) {
      after(async () => {
        try {
          const brief = await buildBrandBrief(site);
          if (!brief) return;
          // Guard on website so a URL changed mid-build isn't given the old site's brief.
          await db()
            .update(agentSettings)
            .set({ brandBrief: brief, brandBriefSource: site })
            .where(and(eq(agentSettings.userId, user.id), eq(agentSettings.website, site)));
        } catch (e) {
          console.error('[brand-brief] build failed:', e instanceof Error ? e.message : String(e));
        }
      });
    }

    return row;
  }, req);
}
