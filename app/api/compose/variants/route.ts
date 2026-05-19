import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { agentSettings } from '../../../../lib/db/schema';
import { generateCompose, type ComposePresetKey } from '../../../../lib/ai/compose';
import { composeVariantsSchema, parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';

const PRESET_KEYS = ['thread', 'announcement', 'recap', 'hot-take', 'lesson', 'reel'] as const;

export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    // Compose hits Anthropic which costs money — rate limit per user.
    const rl = rateLimit('agentRun', `compose:${user.id}`);
    if (!rl.ok) {
      return new Response(
        JSON.stringify({ error: 'rate_limited', retryAfterSec: rl.retryAfterSec }),
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(rl.retryAfterSec) } },
      );
    }
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(composeVariantsSchema, raw);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const preset = (PRESET_KEYS as readonly string[]).includes(body.preset ?? '')
      ? (body.preset as ComposePresetKey)
      : undefined;

    const [settings] = await db()
      .select()
      .from(agentSettings)
      .where(eq(agentSettings.userId, user.id))
      .limit(1);

    const result = await generateCompose({
      prompt: body.prompt,
      platforms: body.platforms.length ? body.platforms : undefined,
      preset,
      voiceTemplate: body.voice ?? settings?.voiceTemplate ?? 'me',
      agentInstructions: settings?.instructions,
      count: body.count ?? 4,
    });

    return result;
  }, req);
}
