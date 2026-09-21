import { eq, ne } from 'drizzle-orm';
import { db } from '../db';
import { agentSettings, drafts, genJobs, videoJobs, mediaAssets, activityLog, type DraftMedia } from '../db/schema';
import { charge } from '../credits/ledger';
import { priceForImage } from '../credits/pricing';
import { AGENT_IMAGE, AGENT_VIDEO } from '../credits/estimator';
import { rewritePromptForMedia } from '../ai/prompt-rewriter';
import { DEFAULT_VIDEO_MODEL } from '../ai/models';
// The hardened generation paths live with the public API. Reused rather than
// copied: row → charge → provider, refund-on-failure and the cron sweepers all
// already work on these rows. (lib/cron/finalizeJobs.ts imports from here too.)
import { insertImageJob, runImageJob, failImageJob, submitVideo } from '../../app/api/v1/shared';
import { publishOrHold } from './publish';

type Post = { userId: string; title: string; body: string; brandBlock: string };

const mediaPrompt = (p: Post, target: 'gpt-image-2' | 'seedance-2') =>
  rewritePromptForMedia({ userPrompt: `${p.title}\n\n${p.body}`.slice(0, 1_500), target, caption: p.body, brandBlock: p.brandBlock });

/** Generate the image for an autopilot post. Null = it failed and the charge was refunded. */
export async function generateAgentImage(p: Post): Promise<DraftMedia | null> {
  const { prompt } = await mediaPrompt(p, 'gpt-image-2');
  const job = await insertImageJob(p.userId, { prompt, ...AGENT_IMAGE, referenceCount: 0, source: null });
  try {
    const unit = priceForImage(AGENT_IMAGE.size, AGENT_IMAGE.quality);
    const charged = await charge({
      userId: p.userId,
      action: unit.action,
      credits: unit.credits,
      meta: { via: 'autopilot', imageJobId: job.id, ...AGENT_IMAGE },
    });
    // The sweeper and failImageJob refund against this link.
    await db().update(genJobs).set({ creditLedgerId: charged.ledgerId, creditsCharged: unit.credits }).where(eq(genJobs.id, job.id));
    job.creditLedgerId = charged.ledgerId;
  } catch (e) {
    await failImageJob(job, 'charge_failed');
    throw e;
  }
  await runImageJob(job, null); // never throws; leaves the row terminal and the money settled
  const [done] = await db().select().from(genJobs).where(eq(genJobs.id, job.id)).limit(1);
  if (!done?.mediaAssetId) return null;
  const [a] = await db().select().from(mediaAssets).where(eq(mediaAssets.id, done.mediaAssetId)).limit(1);
  return a ? { id: a.id, url: a.publicUrl, mimeType: a.mimeType, width: a.width ?? undefined, height: a.height ?? undefined } : null;
}

/** Start the render for an autopilot video post. Returns the video_jobs id to park on the draft. */
export async function submitAgentVideo(p: Post): Promise<string> {
  const { prompt } = await mediaPrompt(p, 'seedance-2');
  const { job } = await submitVideo({
    auth: { userId: p.userId },
    model: DEFAULT_VIDEO_MODEL,
    prompt,
    ...AGENT_VIDEO,
    source: null,
    via: 'autopilot',
  });
  return job.id;
}

/**
 * Finish autopilot video drafts whose render has ended: attach the clip and
 * run the normal schedule-or-hold decision, or fall back to a text draft when
 * the render failed (finalizeVideoJob has already refunded it).
 * Runs after the video sweeper, every five minutes.
 */
export async function attachFinishedVideos(): Promise<number> {
  const rows = await db()
    .select({ draft: drafts, job: videoJobs })
    .from(drafts)
    .innerJoin(videoJobs, eq(drafts.videoJobId, videoJobs.id))
    .where(ne(videoJobs.status, 'pending'))
    .limit(50);

  for (const { draft, job } of rows) {
    const [asset] = job.status === 'completed' && job.mediaAssetId
      ? await db().select().from(mediaAssets).where(eq(mediaAssets.id, job.mediaAssetId)).limit(1)
      : [];
    const media: DraftMedia[] = asset
      ? [{ id: asset.id, url: asset.publicUrl, mimeType: asset.mimeType, width: asset.width ?? undefined, height: asset.height ?? undefined }]
      : [];
    const [updated] = await db()
      .update(drafts)
      .set({ media, videoJobId: null, updatedAt: new Date() })
      .where(eq(drafts.id, draft.id))
      .returning();

    if (!asset) {
      await db().insert(activityLog).values({
        userId: draft.userId,
        kind: 'agent_held',
        title: `Video didn't render: ${draft.title}`,
        body: 'The clip failed and its credits were refunded. The post is in your drafts as text — add media or schedule it as is.',
        meta: { draftId: draft.id, videoJobId: job.id },
      });
      continue;
    }
    const [settings] = await db().select().from(agentSettings).where(eq(agentSettings.userId, draft.userId)).limit(1);
    if (settings) await publishOrHold(settings, updated, draft.variants?.[0]?.score ?? 0);
  }
  return rows.length;
}
