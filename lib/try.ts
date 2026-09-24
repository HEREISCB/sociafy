import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { and, eq, gte, lt, ne, or, sql, isNull, isNotNull, inArray } from 'drizzle-orm';
import { db } from './db';
import { mediaAssets, tryGenerations } from './db/schema';
import { getOpenAI, MODELS } from './ai/client';
import { rewritePromptForMedia } from './ai/prompt-rewriter';
import { createSeedanceTask, getSeedanceTask } from './ai/piapi';
import { deleteObject, publicUrlFor, uploadBuffer } from './storage/r2';
import { turnstileEnabled } from './turnstile';
import { IMAGE_ASPECTS, VIDEO_ASPECTS, type ImageAspect, type VideoAspect } from './try-presets';
import { ensureProfile } from './api';
import { classifyImageFailure } from '../app/api/v1/shared';

export type TryKind = 'image' | 'video';
export type TryRow = typeof tryGenerations.$inferSelect;

/** Free runs per browser or account per 24h. */
export const TRY_PER_DAY: Record<TryKind, number> = { image: 2, video: 1 };
/**
 * Per IP per 24h. Offices, colleges and mobile carriers put many people behind
 * one IP, so once Turnstile is keeping bots out the IP only needs to stop
 * someone clearing cookies over and over. Without Turnstile it stays as strict
 * as the per-browser limit.
 */
export const tryPerIp = (k: TryKind) => (turnstileEnabled() ? { image: 6, video: 3 }[k] : TRY_PER_DAY[k]);
/** Site-wide ceiling per 24h — what bounds the bill when someone rotates IPs. */
const dailyCap = (k: TryKind) =>
  Number(k === 'image' ? process.env.TRY_IMAGE_DAILY_CAP ?? 150 : process.env.TRY_VIDEO_DAILY_CAP ?? 15);

// The cheapest settings that still look good: a video try costs about $0.45
// (5s of 480p Seedance fast), an image about $0.02 (1024² low).
const VIDEO = { durationSec: 5, resolution: '480p', fast: true } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export const VISITOR_COOKIE = 'sfy_try';

export function clientIp(h: Headers): string {
  return h.get('cf-connecting-ip') ?? h.get('x-forwarded-for')?.split(',')[0].trim() ?? h.get('x-real-ip') ?? 'unknown';
}

/** Salted so the table never holds a raw IP. */
export function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(`try:${process.env.CRON_SECRET ?? ''}:${ip}`).digest('hex').slice(0, 32);
}

type Exec = Pick<ReturnType<typeof db>, 'select'>;

export async function tryQuota(kind: TryKind, who: { visitor: string; ipHash: string; userId?: string | null }, x: Exec = db()) {
  const since = new Date(Date.now() - DAY_MS);
  const live = and(eq(tryGenerations.kind, kind), gte(tryGenerations.createdAt, since), ne(tryGenerations.status, 'failed'));
  const mine = or(eq(tryGenerations.visitor, who.visitor), ...(who.userId ? [eq(tryGenerations.claimedBy, who.userId)] : []));
  const n = sql<number>`count(*)::int`;
  const [[{ used }], [{ ipUsed }], [{ total }]] = await Promise.all([
    x.select({ used: n }).from(tryGenerations).where(and(live, mine)),
    x.select({ ipUsed: n }).from(tryGenerations).where(and(live, eq(tryGenerations.ipHash, who.ipHash))),
    x.select({ total: n }).from(tryGenerations).where(live),
  ]);
  const left = Math.max(0, Math.min(TRY_PER_DAY[kind] - used, tryPerIp(kind) - ipUsed));
  return { left, siteFull: total >= dailyCap(kind) };
}

/**
 * Check the quota and record the try as one step. The advisory lock serialises
 * concurrent requests for the same kind, so ten parallel POSTs can't all pass
 * the count before any of them inserts.
 */
export async function reserveTry(
  v: { kind: TryKind; prompt: string; aspect: string | null; visitor: string; ipHash: string; userId: string | null },
): Promise<{ row: TryRow } | { error: 'try_limit' | 'try_busy' }> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'try:' + v.kind}))`);
    const q = await tryQuota(v.kind, { visitor: v.visitor, ipHash: v.ipHash, userId: v.userId }, tx);
    if (q.left === 0) return { error: 'try_limit' as const };
    if (q.siteFull) return { error: 'try_busy' as const };
    const [row] = await tx.insert(tryGenerations)
      .values({ kind: v.kind, prompt: v.prompt, aspect: v.aspect, visitor: v.visitor, ipHash: v.ipHash, claimedBy: v.userId })
      .returning();
    return { row };
  });
}

/**
 * OpenAI's moderation endpoint is free. The watermark puts Sociafy's name on
 * whatever gets made, so refuse flagged prompts before spending anything.
 * Fails open: an outage shouldn't take the tool down, and both models still
 * apply their own filters.
 */
export async function promptFlagged(prompt: string): Promise<boolean> {
  const openai = getOpenAI();
  if (!openai) return false;
  try {
    const r = await openai.moderations.create({ model: 'omni-moderation-latest', input: prompt });
    return r.results.some((x) => x.flagged);
  } catch (e) {
    console.warn('[try] moderation unavailable, allowing', (e as Error).message);
    return false;
  }
}

/**
 * Tiled "Sociafy" watermark plus a bottom banner, as a PNG the size of the
 * preview. Baked into the pixels (sharp for images, ffmpeg overlay for video),
 * so there is no clean copy to pull out of the page.
 */
export function watermarkPng(w: number, h: number): Promise<Buffer> {
  const bar = Math.round(h * 0.075);
  const fs = Math.round(w / 16);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><pattern id="p" width="${fs * 7}" height="${fs * 4}" patternUnits="userSpaceOnUse" patternTransform="rotate(-28)">
      <text x="0" y="${fs * 2}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-weight="700" font-size="${fs}"
        fill="#ffffff" fill-opacity="0.42" stroke="#000000" stroke-opacity="0.18" stroke-width="1">Sociafy</text>
    </pattern></defs>
    <rect width="100%" height="100%" fill="url(#p)"/>
    <rect y="${h - bar}" width="100%" height="${bar}" fill="#000000" fill-opacity="0.55"/>
    <text x="50%" y="${h - bar / 2}" dominant-baseline="middle" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif"
      font-weight="700" font-size="${Math.round(bar * 0.42)}" fill="#ffffff">Made with Sociafy · sociafy.app</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const secretKey = (id: string, ext: string) => `try/${id}/${crypto.randomBytes(16).toString('hex')}.${ext}`;

async function fail(id: string, error: string) {
  await db().update(tryGenerations).set({ status: 'failed', error: error.slice(0, 300), updatedAt: new Date() }).where(eq(tryGenerations.id, id));
}

/** Runs after the response: rewrite, generate, store the original privately and a watermarked copy publicly. */
export async function runImageTry(row: TryRow) {
  try {
    const openai = getOpenAI();
    if (!openai) throw new Error('ai_not_configured');
    const { prompt } = await rewritePromptForMedia({ userPrompt: row.prompt, target: 'gpt-image-2' });
    let res;
    try {
      const { size } = IMAGE_ASPECTS[(row.aspect as ImageAspect) ?? 'square'] ?? IMAGE_ASPECTS.square;
      res = await openai.images.generate({ model: MODELS.image, prompt, size, quality: 'low', n: 1 });
    } catch (e) {
      return fail(row.id, classifyImageFailure(e).message);
    }
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) return fail(row.id, 'The model returned no image. Try a different prompt.');
    const buf = Buffer.from(b64, 'base64');
    const originalKey = secretKey(row.id, 'png');
    // Smaller than the original too, so cropping the banner off still isn't the real thing.
    const { w, h } = IMAGE_ASPECTS[(row.aspect as ImageAspect) ?? 'square'] ?? IMAGE_ASPECTS.square;
    const pw = Math.round((768 * w) / Math.max(w, h)), ph = Math.round((768 * h) / Math.max(w, h));
    const preview = await sharp(buf).resize(pw, ph)
      .composite([{ input: await watermarkPng(pw, ph) }])
      .jpeg({ quality: 78 }).toBuffer();
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
  const aspect = row.aspect && row.aspect in VIDEO_ASPECTS ? (row.aspect as VideoAspect) : '9:16';
  const taskId = await createSeedanceTask({ apiKey, prompt, mode: 'text_to_video', aspect, ...VIDEO });
  await db().update(tryGenerations).set({ taskId, updatedAt: new Date() }).where(eq(tryGenerations.id, row.id));
}

const run = promisify(execFile);

/** Watermarked small copy, sound kept. Null when ffmpeg isn't installed — the page then shows a locked card instead. */
async function watermarkVideo(buf: Buffer, aspect: string | null): Promise<Buffer | null> {
  const { w, h } = VIDEO_ASPECTS[(aspect as VideoAspect) ?? '9:16'] ?? VIDEO_ASPECTS['9:16'];
  const base = join(tmpdir(), `try-${crypto.randomUUID()}`);
  try {
    await Promise.all([writeFile(`${base}.in.mp4`, buf), watermarkPng(w, h).then((wm) => writeFile(`${base}.wm.png`, wm))]);
    await run('ffmpeg', ['-y', '-i', `${base}.in.mp4`, '-i', `${base}.wm.png`,
      '-filter_complex', `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2[v];[v][1:v]overlay=0:0`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', `${base}.out.mp4`], { timeout: 60_000 });
    return await readFile(`${base}.out.mp4`);
  } catch (e) {
    console.warn('[try] ffmpeg watermark unavailable', (e as Error).message?.slice(0, 200));
    return null;
  } finally {
    await Promise.all(['in.mp4', 'wm.png', 'out.mp4'].map((x) => rm(`${base}.${x}`, { force: true })));
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
    const [preview] = await Promise.all([watermarkVideo(buf, row.aspect), uploadBuffer({ key: originalKey, body: buf, contentType: 'video/mp4' })]);
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
        width: r.kind === 'image' ? (IMAGE_ASPECTS[(r.aspect as ImageAspect) ?? 'square'] ?? IMAGE_ASPECTS.square).w : null,
        height: r.kind === 'image' ? (IMAGE_ASPECTS[(r.aspect as ImageAspect) ?? 'square'] ?? IMAGE_ASPECTS.square).h : null,
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

/**
 * Cron sweep (finalize-video-jobs, every 5 min):
 * - collects finished try videos nobody is polling for, before PiAPI's
 *   download link expires (a visitor may close the tab and come back days later);
 * - fails videos still unfinished after 6 hours;
 * - deletes unclaimed tries older than 30 days, files and rows.
 */
export async function sweepTryGenerations() {
  const pending = await db().select().from(tryGenerations)
    .where(and(eq(tryGenerations.kind, 'video'), inArray(tryGenerations.status, ['pending', 'finalizing']), isNotNull(tryGenerations.taskId)))
    .limit(25);
  let advanced = 0, expired = 0, deleted = 0;
  for (const row of pending) {
    if (Date.now() - new Date(row.createdAt).getTime() > 6 * 60 * 60 * 1000) {
      await fail(row.id, 'The video took too long to render. Try again.');
      expired++;
      continue;
    }
    await advanceVideoTry(row).catch((e) => console.error('[try] sweep advance failed', row.id, e));
    advanced++;
  }
  // An image runs inside the request's after(); a deploy restart mid-run leaves it pending forever.
  const stuck = await db().update(tryGenerations)
    .set({ status: 'failed', error: 'Something went wrong on our side. Your free try was not used.', updatedAt: new Date() })
    .where(and(eq(tryGenerations.kind, 'image'), eq(tryGenerations.status, 'pending'), lt(tryGenerations.createdAt, new Date(Date.now() - 15 * 60 * 1000))))
    .returning({ id: tryGenerations.id });
  expired += stuck.length;
  const old = await db().select({ id: tryGenerations.id, originalKey: tryGenerations.originalKey, previewUrl: tryGenerations.previewUrl, kind: tryGenerations.kind })
    .from(tryGenerations)
    .where(and(isNull(tryGenerations.claimedBy), lt(tryGenerations.createdAt, new Date(Date.now() - 30 * DAY_MS))))
    .limit(50);
  for (const r of old) {
    try {
      if (r.originalKey) await deleteObject(r.originalKey);
      if (r.previewUrl) await deleteObject(`try/${r.id}/preview.${r.kind === 'image' ? 'jpg' : 'mp4'}`);
      await db().delete(tryGenerations).where(eq(tryGenerations.id, r.id));
      deleted++;
    } catch (e) {
      console.error('[try] cleanup failed', r.id, e);
    }
  }
  return { advanced, expired, deleted };
}
