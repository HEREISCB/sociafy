import { and, asc, eq, ne, or } from 'drizzle-orm';
import { db } from '../db';
import { mediaAssets, motionVersions, videoJobs } from '../db/schema';
import { MOTION_AI } from '../ai/models';
import type { MotionAiResult, MotionSegment } from '../ai/motionAi';
import { publicUrlFor } from '../storage/r2';

/**
 * The edit history of AI-designed motion graphics (motion_versions, 0020).
 * Every write here is best-effort: a missing table or a bad worker payload
 * must never block a completion or a refund — it only costs the edit UI its
 * timeline.
 */

type Job = typeof videoJobs.$inferSelect;

/** The worker's segments, shape-checked and clamped. Anything malformed is dropped. */
export function cleanSegments(raw: unknown, durationSec: number): MotionSegment[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const sec = (v: unknown) => Math.min(durationSec, Math.max(0, Number(v) || 0));
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string')
    .map((s) => ({
      id: str(s.id, 100),
      label: str(s.label, 80) || 'Segment',
      startSec: sec(s.startSec),
      endSec: sec(s.endSec),
      onScreenText: str(s.onScreenText, 500),
      suggestions: (Array.isArray(s.suggestions) ? s.suggestions : []).filter((x): x is string => typeof x === 'string').slice(0, 8).map((x) => x.slice(0, 200)),
    }))
    .filter((s) => s.endSec > s.startSec)
    .slice(0, 40);
}

/** Store a finished render's segments + poster. Idempotent; an edit's row (from submit) keeps its parent link. */
export async function saveMotionResult(job: Pick<Job, 'id' | 'userId' | 'durationSec'>, r: MotionAiResult): Promise<void> {
  const segments = cleanSegments(r.segments, job.durationSec);
  const posterKey = r.posterKey?.startsWith(`users/${job.userId}/`) ? r.posterKey : null;
  try {
    await db().insert(motionVersions)
      .values({ videoJobId: job.id, rootJobId: job.id, segments, posterKey })
      .onConflictDoUpdate({ target: motionVersions.videoJobId, set: { segments, posterKey } });
  } catch (e) {
    console.warn('[motion-versions] save failed:', e instanceof Error ? e.message.slice(0, 200) : e);
  }
}

/** The original render a version descends from (itself for an original). */
export async function rootOf(jobId: string): Promise<string> {
  const [v] = await db().select({ root: motionVersions.rootJobId }).from(motionVersions).where(eq(motionVersions.videoJobId, jobId)).limit(1);
  return v?.root ?? jobId;
}

/** Link a new edit job to its parent, before it is charged. */
export async function recordEdit(a: { jobId: string; rootJobId: string; parentJobId: string; segmentId: string | null; instruction: string }): Promise<void> {
  await db().insert(motionVersions).values({
    videoJobId: a.jobId, rootJobId: a.rootJobId, parentJobId: a.parentJobId, segmentId: a.segmentId, instruction: a.instruction,
  });
}

/** An AI-designed motion job of this user's, by job id OR its media asset id (the composer only has the latter). */
export async function findMotionJob(userId: string, id: string): Promise<Job | null> {
  const [job] = await db().select().from(videoJobs).where(and(
    eq(videoJobs.userId, userId),
    eq(videoJobs.provider, MOTION_AI.backend),
    or(eq(videoJobs.id, id), eq(videoJobs.mediaAssetId, id)),
  )).limit(1);
  return job ?? null;
}

export type MotionVersion = {
  jobId: string;
  version: number;
  status: string;
  instruction: string | null;
  segmentId: string | null;
  createdAt: string;
  asset: { id: string; publicUrl: string; mimeType: string; label: string | null } | null;
  posterUrl: string | null;
  segments: MotionSegment[];
};

/** Every non-failed version in this job's family, oldest first (v1 = the original). */
export async function listVersions(userId: string, job: Job): Promise<MotionVersion[]> {
  const root = await rootOf(job.id);
  const rows = await db()
    .select({ job: videoJobs, v: motionVersions, asset: mediaAssets })
    .from(videoJobs)
    .leftJoin(motionVersions, eq(motionVersions.videoJobId, videoJobs.id))
    .leftJoin(mediaAssets, eq(mediaAssets.id, videoJobs.mediaAssetId))
    .where(and(eq(videoJobs.userId, userId), ne(videoJobs.status, 'failed'), or(eq(videoJobs.id, root), eq(motionVersions.rootJobId, root))))
    .orderBy(asc(videoJobs.createdAt));
  return rows.map((r, i) => ({
    jobId: r.job.id,
    version: i + 1,
    status: r.job.status,
    instruction: r.v?.instruction ?? null,
    segmentId: r.v?.segmentId ?? null,
    createdAt: r.job.createdAt.toISOString(),
    asset: r.asset ? { id: r.asset.id, publicUrl: r.asset.publicUrl, mimeType: r.asset.mimeType, label: r.asset.label } : null,
    posterUrl: r.v?.posterKey ? publicUrlFor(r.v.posterKey) : null,
    segments: r.v?.segments ?? [],
  }));
}
