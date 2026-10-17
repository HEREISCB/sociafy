import { z } from 'zod';
import { getBalance } from '../credits/ledger';
import { isStubMode } from '../env';
import { motionConfigured } from '../ai/motion';
import { motionAiConfigured } from '../ai/motionAi';
import { motionAiReady, motionReady } from '../brand/kit';
import type { Availability } from '../ai/videoBrain';
import { loadBrand } from './motionJob';

/** What the video brain needs to know about this user: engines they can use right now, and their balance. */
export async function brainContext(userId: string): Promise<{ availability: Availability; balance: number }> {
  const [{ kit, profile }, balance] = await Promise.all([loadBrand(userId), getBalance(userId)]);
  return {
    balance,
    availability: {
      motion1: !!process.env.PIAPI_API_KEY,
      cinema: !isStubMode.cue(),
      templates: motionConfigured() && motionReady(kit, profile),
      aiMotion: motionAiConfigured() && motionAiReady(kit, profile),
      kitScreenshots: kit.screenshots?.length ?? 0,
    },
  };
}

/** An attachment on the post being planned. Only images are used (as footage frames); the rest only inform the plan. */
export const attachmentSchema = z.object({
  url: z.string().url().max(2_000),
  mimeType: z.string().trim().max(100),
});
