import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../../lib/api';
import { db } from '../../../../../lib/db';
import { genJobs, mediaAssets } from '../../../../../lib/db/schema';
import { getTtsResult, getAvatarResult, modalConfigured, type Engine } from '../../../../../lib/ai/modal';
import { keyFromPublicUrl } from '../../../../../lib/storage/r2';
import { refund } from '../../../../../lib/credits/ledger';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/media/gen-job/[id]
 *
 * Polls a Modal job (kind = 'tts' | 'avatar'). The Modal GPU function uploads
 * its output straight to R2 and returns the public URL, so on completion we
 * only record a media_assets row — no download hop (unlike the Seedance poller).
 *
 * Idempotent: already-completed jobs short-circuit; concurrent polls can't
 * double-finalize because completion re-checks status under the row update.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    if (!id) return jsonError('missing_job_id', 400);

    const [job] = await db()
      .select()
      .from(genJobs)
      .where(and(eq(genJobs.id, id), eq(genJobs.userId, user.id)))
      .limit(1);
    if (!job) return jsonError('job_not_found', 404);

    if (job.status === 'completed' && job.mediaAssetId) {
      const [asset] = await db().select().from(mediaAssets).where(eq(mediaAssets.id, job.mediaAssetId)).limit(1);
      return { status: 'completed' as const, asset };
    }
    if (job.status === 'failed') {
      return { status: 'failed' as const, error: job.error ?? 'unknown' };
    }

    const isAvatar = job.kind === 'avatar';
    const engine: Engine = isAvatar ? 'avatar' : 'voice';

    // STUB MODE: finalize immediately with a placeholder asset from /public.
    if (!modalConfigured(engine)) {
      const publicUrl = isAvatar ? '/stub/avatar.mp4' : '/stub/tts.wav';
      const [asset] = await db()
        .insert(mediaAssets)
        .values({
          userId: user.id,
          storageKey: 'stub',
          publicUrl,
          mimeType: isAvatar ? 'video/mp4' : 'audio/wav',
          sizeBytes: 0,
          label: isAvatar ? 'Avatar (stub)' : 'Voice (stub)',
        })
        .returning();
      await db()
        .update(genJobs)
        .set({ status: 'completed', mediaAssetId: asset.id, updatedAt: new Date() })
        .where(eq(genJobs.id, job.id));
      return { status: 'completed' as const, asset, stub: true };
    }

    // Poll the engine.
    let status: 'pending' | 'done' | 'failed';
    let url: string | undefined;
    let error: string | undefined;
    try {
      if (isAvatar) {
        const r = await getAvatarResult(job.providerCallId);
        status = r.status;
        url = r.videoUrl;
        error = r.error;
      } else {
        const r = await getTtsResult(job.providerCallId);
        status = r.status;
        url = r.audioUrl;
        error = r.error;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[gen-job] poll failed:', msg.slice(0, 300));
      return { status: 'pending' as const, pollError: msg.slice(0, 200) };
    }

    if (status === 'pending') {
      await db().update(genJobs).set({ updatedAt: new Date() }).where(eq(genJobs.id, job.id));
      return { status: 'pending' as const };
    }

    if (status === 'failed' || !url) {
      await db()
        .update(genJobs)
        .set({ status: 'failed', error: error ?? 'engine_failed', updatedAt: new Date() })
        .where(eq(genJobs.id, job.id));
      if (job.creditLedgerId) {
        try {
          await refund({ userId: user.id, ledgerId: job.creditLedgerId, reason: error ?? 'engine_failed' });
        } catch (e) {
          console.warn('[gen-job] refund failed:', e instanceof Error ? e.message : e);
        }
      }
      return { status: 'failed' as const, error: error ?? 'engine_failed' };
    }

    // Done — the artifact already lives in R2. Just record it.
    const mimeType = isAvatar ? 'video/mp4' : 'audio/wav';
    const [asset] = await db()
      .insert(mediaAssets)
      .values({
        userId: user.id,
        storageKey: keyFromPublicUrl(url),
        publicUrl: url,
        mimeType,
        sizeBytes: 0,
        label: isAvatar ? 'Avatar video' : 'Voice clip',
      })
      .returning();
    await db()
      .update(genJobs)
      .set({ status: 'completed', mediaAssetId: asset.id, updatedAt: new Date() })
      .where(eq(genJobs.id, job.id));

    return { status: 'completed' as const, asset };
  }, req);
}
