import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { agentSettings, activityLog, NICHES, VOICE_TEMPLATES } from '../../../../lib/db/schema';

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
    const body = await req.json().catch(() => ({}));
    const patch: Partial<typeof agentSettings.$inferInsert> = { updatedAt: new Date() };
    if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
    if (typeof body?.instructions === 'string') patch.instructions = body.instructions;
    if (typeof body?.cadencePerWeek === 'number') patch.cadencePerWeek = body.cadencePerWeek;
    if (typeof body?.autoPublishThreshold === 'number') patch.autoPublishThreshold = body.autoPublishThreshold;
    if (body?.quietHours) patch.quietHours = body.quietHours;
    if (typeof body?.brandSafetyStrict === 'boolean') patch.brandSafetyStrict = body.brandSafetyStrict;
    if (Array.isArray(body?.niches)) {
      // Allow both predefined niches and user-defined custom niches (free text).
      patch.niches = body.niches
        .filter((n: unknown): n is string => typeof n === 'string')
        .map((n: string) => n.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40))
        .filter((n: string) => n.length > 0);
    }
    if (typeof body?.voiceTemplate === 'string' && (VOICE_TEMPLATES as readonly string[]).includes(body.voiceTemplate)) {
      patch.voiceTemplate = body.voiceTemplate;
    }
    const [row] = await db()
      .update(agentSettings)
      .set(patch)
      .where(eq(agentSettings.userId, user.id))
      .returning();

    if (typeof body?.enabled === 'boolean' && body.enabled !== current.enabled) {
      await db().insert(activityLog).values({
        userId: user.id,
        kind: body.enabled ? 'agent_enabled' : 'agent_disabled',
        title: body.enabled ? 'Autopilot enabled' : 'Autopilot disabled',
        meta: {},
      });
    }
    return row;
  });
}
