import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { and, eq, gte, ne, or, sql, isNull } from 'drizzle-orm';
import { db } from './db';
import { mediaAssets, tryGenerations } from './db/schema';
import { getOpenAI, MODELS } from './ai/client';
import { rewritePromptForMedia } from './ai/prompt-rewriter';
import { createSeedanceTask, getSeedanceTask } from './ai/piapi';
import { publicUrlFor, uploadBuffer } from './storage/r2';
import { ensureProfile } from './api';
import { classifyImageFailure } from '../app/api/v1/shared';

export type TryKind = 'image' | 'video';
export type TryRow = typeof tryGenerations.$inferSelect;

/** Free runs per visitor (cookie, IP or account — whichever has used the most) per 24h. */
export const TRY_PER_DAY: Record<TryKind, number> = { image: 2, video: 1 };
/** Site-wide ceiling per 24h — what bounds the bill when someone rotates IPs. */
const dailyCap = (k: TryKind) =>
  Number(k === 'image' ? process.env.TRY_IMAGE_DAILY_CAP ?? 150 : process.env.TRY_VIDEO_DAILY_CAP ?? 15);

// The cheapest settings that still look good: a video try costs about $0.45
// (5s of 480p Seedance fast), an image about $0.02 (1024² low).
const VIDEO = { durationSec: 5, resolution: '480p', aspect: '9:16', fast: true } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export const VISITOR_COOKIE = 'sfy_try';

export function clientIp(h: Headers): string {
  return h.get('cf-connecting-ip') ?? h.get('x-forwarded-for')?.split(',')[0].trim() ?? h.get('x-real-ip') ?? 'unknown';
}

/** Salted so the table never holds a raw IP. */
export function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(`try:${process.env.CRON_SECRET ?? ''}:${ip}`).digest('hex').slice(0, 32);
}

export async function tryQuota(kind: TryKind, who: { visitor: string; ipHash: string; userId?: string | null }) {
  const since = new Date(Date.now() - DAY_MS);
  const live = and(eq(tryGenerations.kind, kind), gte(tryGenerations.createdAt, since), ne(tryGenerations.status, 'failed'));
  const mine = or(
    eq(tryGenerations.visitor, who.visitor),
    eq(tryGenerations.ipHash, who.ipHash),
    ...(who.userId ? [eq(tryGenerations.claimedBy, who.userId)] : []),
  );
  const [[{ used }], [{ total }]] = await Promise.all([
    db().select({ used: sql<number>`count(*)::int` }).from(tryGenerations).where(and(live, mine)),
    db().select({ total: sql<number>`count(*)::int` }).from(tryGenerations).where(live),
  ]);
  return { left: Math.max(0, TRY_PER_DAY[kind] - used), siteFull: total >= dailyCap(kind) };
}

const secretKey = (id: string, ext: string) => `try/${id}/${crypto.randomBytes(16).toString('hex')}.${ext}`;

async function fail(id: string, error: string) {
  await db().update(tryGenerations).set({ status: 'failed', error: error.slice(0, 300), updatedAt: new Date() }).where(eq(tryGenerations.id, id));
}

/** Runs after the response: rewrite, generate, store the original privately and a blurred copy publicly. */
export async function runImageTry(row: TryRow) {
  try {
    const openai = getOpenAI();
    if (!openai) throw new Error('ai_not_configured');
    const { prompt } = await rewritePromptForMedia({ userPrompt: row.prompt, target: 'gpt-image-2' });
    let res;
    try {
      res = await openai.images.generate({ model: MODELS.image, prompt, size: '1024x1024', quality: 'low', n: 1 });
    } catch (e) {
      return fail(row.id, classifyImageFailure(e).message);
    }
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) return fail(row.id, 'The model returned no image. Try a different prompt.');
    const buf = Buffer.from(b64, 'base64');
    const originalKey = secretKey(row.id, 'png');
    const preview = await sharp(buf).resize(512).blur(14).jpeg({ quality: 60 }).toBuffer();
    const previewKey = `try/${row.id}/preview.jpg`;
    await Promise.all([
      uploadBuffer({ key: originalKey, body: buf, contentType: 'image/png' }),
      uploadBuffer({ key: previewKey, body: preview, contentType: 'image/jpeg' }),
    ]);
    await db().update(tryGenerations)
      .set({ status: 'ready', originalKey, previewUrl: publicUrlFor(previewKey), updatedAt: new Date() })
      .where(eq(tryGenerations.id, row.id));
  } catch (e) {
    console.error('[try] image failed', row.id, e);
    await fail(row.id, 'Something went wrong on our side. Your free try was not used.');
  }
}

/** Submits the Seedance task. Throws on submit failure (the caller marks the row failed). */
export async function submitVideoTry(row: TryRow) {
  const apiKey = process.env.PIAPI_API_KEY;
  if (!apiKey) throw new Error('video_provider_not_configured');
  const { prompt } = await rewritePromptForMedia({ userPrompt: row.prompt, target: 'seedance-2' });
  const taskId = await createSeedanceTask({ apiKey, prompt, mode: 'text_to_video', ...VIDEO });
  await db().update(tryGenerations).set({ taskId, updatedAt: new Date() }).where(eq(tryGenerations.id, row.id));
}

const run = promisify(execFile);

/** Small, heavily blurred, silent copy. Null when ffmpeg isn't installed — the page then shows a locked card instead. */
async function blurVideo(buf: Buffer): Promise<Buffer | null> {
  const base = join(tmpdir(), `try-${crypto.randomUUID()}`);
  try {
    await writeFile(`${base}.in.mp4`, buf);
    await run('ffmpeg', ['-y', '-i', `${base}.in.mp4`, '-vf', 'scale=320:-2,boxblur=16:2', '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '34', '-movflags', '+faststart', `${base}.out.mp4`], { timeout: 60_000 });
    return await readFile(`${base}.out.mp4`);
  } catch (e) {
    console.warn('[try] ffmpeg blur unavailable', (e as Error).message?.slice(0, 200));
    return null;
  } finally {
    await rm(`${base}.in.mp4`, { force: true });
    await rm(`${base}.out.mp4`, { force: true });
  }
}

/**
 * Called on each status poll of a pending video. Checks PiAPI and, once done,
 * finalizes exactly once: the status flip to 'finalizing' is the lock (a crashed
 * finalize is retaken after 5 minutes).
 */
export async function advanceVideoTry(row: TryRow) {
  if (!row.taskId || !process.env.PIAPI_API_KEY) return;
  const task = await getSeedanceTask({ taskId: row.taskId, apiKey: process.env.PIAPI_API_KEY });
  if (task.status === 'failed') return fail(row.id, task.error ?? 'The video model could not make this one. Try a different prompt.');
  if (task.status !== 'completed' || !task.videoUrl) return;
  const [claimed] = await db().update(tryGenerations)
    .set({ status: 'finalizing', updatedAt: new Date() })
    .where(and(eq(tryGenerations.id, row.id), or(
      eq(tryGenerations.status, 'pending'),
      and(eq(tryGenerations.status, 'finalizing'), sql`${tryGenerations.updatedAt} < now() - interval '5 minutes'`),
    )))
    .returning({ id: tryGenerations.id });
  if (!claimed) return;
  try {
    const res = await fetch(task.videoUrl);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const originalKey = secretKey(row.id, 'mp4');
    const [preview] = await Promise.all([blurVideo(buf), uploadBuffer({ key: originalKey, body: buf, contentType: 'video/mp4' })]);
    let previewUrl: string | null = null;
    if (preview) {
      const previewKey = `try/${row.id}/preview.mp4`;
      await uploadBuffer({ key: previewKey, body: preview, contentType: 'video/mp4' });
      previewUrl = publicUrlFor(previewKey);
    }
    await db().update(tryGenerations).set({ status: 'ready', originalKey, previewUrl, updatedAt: new Date() }).where(eq(tryGenerations.id, row.id));
  } catch (e) {
    console.error('[try] video finalize failed', row.id, e);
    // Back to pending: the next poll retries the download.
    await db().update(tryGenerations).set({ status: 'pending', updatedAt: new Date() }).where(eq(tryGenerations.id, row.id));
  }
}

/**
 * Hands the generation to a signed-in user: only the browser that made it can
 * claim it, and only once. Once ready it also lands in their media library.
 */
export async function claimTry(row: TryRow, userId: string, visitor: string | undefined): Promise<TryRow> {
  let r = row;
  if (!r.claimedBy && visitor && r.visitor === visitor) {
    const [c] = await db().update(tryGenerations).set({ claimedBy: userId })
      .where(and(eq(tryGenerations.id, r.id), isNull(tryGenerations.claimedBy))).returning();
    if (c) r = c;
  }
  if (r.claimedBy === userId && r.status === 'ready' && r.originalKey && !r.mediaAssetId) {
    const assetId = crypto.randomUUID();
    const [won] = await db().update(tryGenerations).set({ mediaAssetId: assetId })
      .where(and(eq(tryGenerations.id, r.id), isNull(tryGenerations.mediaAssetId))).returning();
    if (won) {
      await ensureProfile(userId);
      await db().insert(mediaAssets).values({
        id: assetId,
        userId,
        storageKey: r.originalKey,
        publicUrl: publicUrlFor(r.originalKey),
        mimeType: r.kind === 'image' ? 'image/png' : 'video/mp4',
        width: r.kind === 'image' ? 1024 : null,
        height: r.kind === 'image' ? 1024 : null,
        label: r.prompt.slice(0, 80),
      });
      r = won;
    }
  }
  return r;
}

/** What the browser may see. The original URL only ever leaves for its owner. */
export function tryView(r: TryRow, userId: string | null) {
  const unlocked = !!userId && r.claimedBy === userId;
  return {
    id: r.id,
    kind: r.kind,
    prompt: r.prompt,
    status: r.status === 'finalizing' ? 'pending' : r.status,
    error: r.error,
    previewUrl: r.previewUrl,
    unlocked,
    url: unlocked && r.status === 'ready' && r.originalKey ? publicUrlFor(r.originalKey) : null,
  };
}
export type TryView = ReturnType<typeof tryView>;
