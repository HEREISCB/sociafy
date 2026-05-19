import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { agentSettings, activityLog } from '../../../../lib/db/schema';
import { agentSettingsUpdateSchema, parseBody } from '../../../../lib/validation';

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
    return row;
  }, req);
}
