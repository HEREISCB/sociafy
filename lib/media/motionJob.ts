import { eq } from 'drizzle-orm';
import { db } from '../db';
import { agentSettings, brandKits, videoJobs } from '../db/schema';
import { motionAiReady, motionReady, motionVariables, type BrandKit, type BrandProfile } from '../brand/kit';
import { MOTION_AI, MOTION_GRAPHICS, MOTION_TEMPLATES, type MotionTemplate } from '../ai/models';
import { submitMotion } from '../ai/motion';
import { submitMotionAi, type MotionAiBrand } from '../ai/motionAi';
import { writeMotionCopy } from '../ai/motionCopy';
import { priceForMotion, priceForMotionAi, type CreditAction } from '../credits/pricing';
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

  return startJob({
    userId, price,
    row: { provider: MOTION_GRAPHICS.backend, prompt: topic, rewrittenPrompt: copy.hook || null, durationSec, aspect, genMode: `motion-${template}` },
    meta: { template, aspect, durationSec, via: args.via },
    submit: () => submitMotion({
      template, aspect, vars,
      videoKey: makeMediaKey(userId, `motion-${template}.mp4`),
      posterKey: makeMediaKey(userId, `motion-${template}-poster.jpg`),
    }),
  });
}

/**
 * Start one AI-designed motion graphic: the worker authors it from the post
 * text + brand kit. Same money semantics as submitMotionVideo. Readiness is
 * name + main color (motionAiReady) — the worker designs around a missing logo.
 */
export async function submitMotionAiVideo(args: {
  userId: string;
  aspect: '9:16' | '16:9' | '1:1';
  durationSec: number;
  topic: string;
  via: 'compose' | 'autopilot';
}): Promise<{ job: typeof videoJobs.$inferSelect; creditsCharged: number }> {
  const { userId, aspect, topic } = args;
  const { kit, profile } = await loadBrand(userId);
  if (!motionAiReady(kit, profile)) throw new MotionNotReady();

  const { min, max } = MOTION_AI.durationSec;
  const durationSec = Math.min(max, Math.max(min, Math.round(args.durationSec)));
  const price = priceForMotionAi(durationSec);
  const pre = await ensureBalance(userId, price.credits);
  if (!pre.ok) throw new InsufficientCreditsError(pre.balance, pre.needed);

  // motionVariables picks the font URLs ('' = none chosen); copy is the worker's job.
  const v = motionVariables(kit, profile, { hook: '', lines: [], facts: [] });
  const brand: MotionAiBrand = {
    brandName: v.brandName || undefined,
    tagline: v.tagline || undefined,
    cta: v.cta || undefined,
    colors: v.colors,
    logoUrl: v.logoUrl ?? undefined,
    logoReverseUrl: v.logoReverseUrl ?? undefined,
    fontDisplayUrl: v.fontDisplayUrl || undefined,
    fontBodyUrl: v.fontBodyUrl || undefined,
    style: v.style,
  };

  return startJob({
    userId, price,
    row: { provider: MOTION_AI.backend, prompt: topic, rewrittenPrompt: null, durationSec, aspect, genMode: 'motion-ai' },
    meta: { template: 'ai', aspect, durationSec, via: args.via },
    submit: () => submitMotionAi({
      prompt: topic.slice(0, 4_000), aspect, durationSec, brand,
      videoKey: makeMediaKey(userId, 'motion-ai.mp4'),
      posterKey: makeMediaKey(userId, 'motion-ai-poster.jpg'),
    }),
  });
}

/** row → charge → submit; refund on a definitive submit failure, leave an ambiguous one to the sweeper. */
async function startJob(a: {
  userId: string;
  price: { action: CreditAction; credits: number };
  row: { provider: string; prompt: string; rewrittenPrompt: string | null; durationSec: number; aspect: string; genMode: string };
  meta: Record<string, unknown>;
  submit: () => Promise<{ callId: string }>;
}): Promise<{ job: typeof videoJobs.$inferSelect; creditsCharged: number }> {
  const { userId, price } = a;
  const [row] = await db()
    .insert(videoJobs)
    .values({ ...a.row, userId, providerTaskId: '', status: 'pending', prompt: a.row.prompt.slice(0, 2_000), quality: '1080p' })
    .returning();

  let charged;
  try {
    charged = await charge({ userId, action: price.action, credits: price.credits, meta: { videoJobId: row.id, ...a.meta } });
  } catch (e) {
    await db().update(videoJobs).set({ status: 'failed', error: 'charge_failed', updatedAt: new Date() }).where(eq(videoJobs.id, row.id));
    throw e;
  }
  await db().update(videoJobs)
    .set({ creditLedgerId: charged.ledgerId, creditsCharged: price.credits, updatedAt: new Date() })
    .where(eq(videoJobs.id, row.id));

  try {
    const { callId } = await a.submit();
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
