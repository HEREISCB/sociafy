import { NextRequest } from 'next/server';
import { withUser, jsonError } from '../../../../../../lib/api';
import { motionAiConfigured, getMotionAiResult } from '../../../../../../lib/ai/motionAi';
import { cleanSegments, findMotionJob, listVersions, saveMotionResult } from '../../../../../../lib/media/motionVersions';

export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/media/motion-ai/[jobId]/segments → the edit view of one finished
 * AI-designed motion graphic: its segments, video + poster, and every version
 * in its family (v1 = the original; pending edits included so a reopened
 * editor can keep following them). `jobId` may also be the media asset id.
 * 404 unless it's the caller's own completed AI-designed render.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  return withUser(async (user) => {
    const { jobId } = await ctx.params;
    if (!motionAiConfigured() || !UUID.test(jobId ?? '')) return jsonError('not_found', 404);
    const job = await findMotionJob(user.id, jobId);
    if (!job || job.status !== 'completed' || !job.mediaAssetId) return jsonError('not_found', 404);

    let versions;
    try {
      versions = await listVersions(user.id, job);
    } catch (e) {
      console.error('[motion-segments] versions failed:', e instanceof Error ? e.message.slice(0, 200) : e);
      return jsonError('motion_edit_unavailable', 503);
    }
    const me = versions.find((v) => v.jobId === job.id);
    if (!me?.asset) return jsonError('not_found', 404);

    // Rendered before segments were stored (or the save failed): ask the worker once, keep the answer.
    if (!me.segments.length && job.providerTaskId) {
      try {
        const r = await getMotionAiResult(job.providerTaskId);
        if (r.status === 'done') {
          me.segments = cleanSegments(r.segments, job.durationSec);
          await saveMotionResult(job, r);
        }
      } catch (e) {
        console.warn('[motion-segments] worker lookup failed:', e instanceof Error ? e.message.slice(0, 200) : e);
      }
    }

    return {
      jobId: job.id,
      version: me.version,
      durationSec: job.durationSec,
      aspect: job.aspect,
      videoUrl: me.asset.publicUrl,
      posterUrl: me.posterUrl,
      segments: me.segments,
      versions: versions.map((v) => ({
        jobId: v.jobId, version: v.version, status: v.status, instruction: v.instruction,
        assetId: v.asset?.id ?? null, videoUrl: v.asset?.publicUrl ?? null, posterUrl: v.posterUrl,
      })),
    };
  }, req);
}
