import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { agentSettings, PLATFORMS, type Platform, VOICE_TEMPLATES, type VoiceTemplate } from '../../../../lib/db/schema';
import { generateCompose, type ComposePresetKey } from '../../../../lib/ai/compose';

const PRESET_KEYS = ['thread', 'announcement', 'recap', 'hot-take', 'lesson', 'reel'] as const;

export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const body = await req.json().catch(() => ({}));
    const prompt = (body?.prompt ?? '').toString().trim();
    if (!prompt) return jsonError('prompt_required');

    const platforms = (Array.isArray(body?.platforms) ? body.platforms : [])
      .filter((p: string): p is Platform => (PLATFORMS as readonly string[]).includes(p));

    const preset = (PRESET_KEYS as readonly string[]).includes(body?.preset)
      ? (body.preset as ComposePresetKey)
      : undefined;

    const voiceTemplate = (VOICE_TEMPLATES as readonly string[]).includes(body?.voiceTemplate)
      ? (body.voiceTemplate as VoiceTemplate)
      : undefined;

    const [settings] = await db()
      .select()
      .from(agentSettings)
      .where(eq(agentSettings.userId, user.id))
      .limit(1);

    const result = await generateCompose({
      prompt,
      platforms: platforms.length ? platforms : undefined,
      preset,
      voiceTemplate: voiceTemplate ?? settings?.voiceTemplate ?? 'me',
      agentInstructions: settings?.instructions,
      count: 4,
    });

    return result;
  });
}
