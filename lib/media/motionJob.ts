import { eq } from 'drizzle-orm';
import { db } from '../db';
import { agentSettings, brandKits, videoJobs } from '../db/schema';
import { motionReady, motionVariables, type BrandKit, type BrandProfile } from '../brand/kit';
import { MOTION_GRAPHICS, MOTION_TEMPLATES, type MotionTemplate } from '../ai/models';
import { submitMotion } from '../ai/motion';
import { writeMotionCopy } from '../ai/motionCopy';
import { priceForMotion } from '../credits/pricing';
import { charge, ensureBalance, refund, InsufficientCreditsError } from '../credits/ledger';
import { makeMediaKey } from '../storage/r2';

/** No HTTP response came back, so the engine may have taken the job: the sweeper settles it. */
const AMBIGUOUS_SUBMIT_RX = /ETIMEDOUT|ECONNRESET|ECONNABORTED|EPIPE|socket hang up|TimeoutError|aborted/i;

export class MotionNotReady extends Error {
  constructor() { super('brand_kit_incomplete'); }
}

export async function loadBrand(userId: string): Promise<{ kit: BrandKit; profile: Pick<BrandProfile, 'companyName' | 'website'> }> {
  const [[k], [s]] = await Promise.all([
    db().select({ kit: brandKits.kit }).from(brandKits).where(eq(brandKits.userId, userId)).limit(1),
    db().select({ companyName: agentSettings.companyName, website: agentSettings.website })
      .from(agentSettings).where(eq(agentSettings.userId, userId)).limit(1),
  ]);
  return { kit: k?.kit ?? {}, profile: s ?? { companyName: null, website: null } };
}

/**
 * Start one motion-graphics render: copy → row → charge → submit, refund on a
 * definitive submit failure. Same ordering and states as submitVideo
 * (app/api/v1/shared.ts), so finalizeVideoJob and the cron sweeper settle it.
 * Throws MotionNotReady / InsufficientCreditsError before anything is charged.
 */
export async function submitMotionVideo(args: {
  userId: string;
  template: MotionTemplate;
  aspect: '9:16' | '16:9';
  topic: string;
  via: 'compose' | 'autopilot';
}): Promise<{ job: typeof videoJobs.$inferSelect; creditsCharged: number }> {
  const { userId, template, aspect, topic } = args;
  const { kit, profile } = await loadBrand(userId);
  if (!motionReady(kit, profile)) throw new MotionNotReady();

  const durationSec = MOTION_TEMPLATES[template].durationSec;
  const price = priceForMotion(durationSec);
  const pre = await ensureBalance(userId, price.credits);
  if (!pre.ok) throw new InsufficientCreditsError(pre.balance, pre.needed);

  const copy = await writeMotionCopy({
    template, topic, brandName: profile.companyName?.trim() ?? '', tagline: kit.tagline, facts: kit.facts ?? [], tone: kit.voice?.tone,
  });
  const vars = motionVariables(kit, profile, copy);

  const [row] = await db()
    .insert(videoJobs)
    .values({
      userId,
      provider: MOTION_GRAPHICS.backend,
      providerTaskId: '',
      status: 'pending',
      prompt: topic.slice(0, 2_000),
      rewrittenPrompt: copy.hook || null,
      durationSec,
      aspect,
      quality: '1080p',
      genMode: `motion-${template}`,
    })
    .returning();

  let charged;
  try {
    charged = await charge({
      userId,
      action: price.action,
      credits: price.credits,
      meta: { videoJobId: row.id, template, aspect, durationSec, via: args.via },
    });
  } catch (e) {
    await db().update(videoJobs).set({ status: 'failed', error: 'charge_failed', updatedAt: new Date() }).where(eq(videoJobs.id, row.id));
    throw e;
  }
  await db().update(videoJobs)
    .set({ creditLedgerId: charged.ledgerId, creditsCharged: price.credits, updatedAt: new Date() })
    .where(eq(videoJobs.id, row.id));

  try {
    const { callId } = await submitMotion({
      template, aspect, vars,
      videoKey: makeMediaKey(userId, `motion-${template}.mp4`),
      posterKey: makeMediaKey(userId, `motion-${template}-poster.jpg`),
    });
    const [live] = await db().update(videoJobs)
      .set({ providerTaskId: callId, updatedAt: new Date() })
      .where(eq(videoJobs.id, row.id))
      .returning();
    return { job: live, creditsCharged: price.credits };
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    if (AMBIGUOUS_SUBMIT_RX.test(msg)) {
      await db().update(videoJobs)
        .set({ error: `submit_unconfirmed: ${msg.slice(0, 160)}`, updatedAt: new Date() })
        .where(eq(videoJobs.id, row.id));
      return { job: row, creditsCharged: price.credits };
    }
    await db().update(videoJobs)
      .set({ status: 'failed', error: `submit_failed: ${msg.slice(0, 200)}`, updatedAt: new Date() })
      .where(eq(videoJobs.id, row.id));
    try {
      await refund({ userId, ledgerId: charged.ledgerId, reason: 'submit_failed', meta: { videoJobId: row.id } });
    } catch (re) {
      console.warn('[motion] refund failed:', re instanceof Error ? re.message : re);
    }
    throw e;
  }
}

/** Autopilot's pick for a post: facts → stat, screenshots → showcase, else stat (hook + kicker). */
export function autopilotTemplate(kit: BrandKit): MotionTemplate {
  if (kit.facts?.length) return 'stat';
  return (kit.screenshots?.length ?? 0) >= 2 ? 'showcase' : 'stat';
}
