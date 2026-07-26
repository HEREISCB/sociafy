import { and, eq, sql } from 'drizzle-orm';
import type { ApiKeyAuth } from '../../../lib/api-key';
import { db } from '../../../lib/db';
import { creditLedger, videoJobs } from '../../../lib/db/schema';
import { isStubMode } from '../../../lib/env';
import { charge, ensureBalance, InsufficientCreditsError, refund } from '../../../lib/credits/ledger';
import { priceForVideo, type VideoQuality } from '../../../lib/credits/pricing';
import { createSeedanceTask, type SeedanceAspect } from '../../../lib/ai/piapi';

/**
 * Shared plumbing for the public v1 API. Not a route (no `route.ts`), just a
 * colocated module.
 *
 * Two rules govern everything here:
 *  1. Nothing upstream leaks. No provider name, task id, or raw error body ever
 *     reaches a v1 response — callers get stable codes from PUBLIC_ERRORS.
 *  2. A row and a charge exist before the provider can bill us. Copied from
 *     app/api/media/generate-video (row → charge → submit); see submitVideo.
 */

export type VideoJob = typeof videoJobs.$inferSelect;

/** Flat `{ error, message }` — same envelope `withApiKey` and `jsonError` emit. */
export function apiError(
  code: string,
  status: number,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify({ error: code, message, ...extra }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Postgres unique_violation (23505). Duplicated from lib/credits/ledger's
 * private helper because it isn't exported; drizzle wraps pg errors, so walk
 * `.cause`.
 */
export function isUniqueViolation(e: unknown): boolean {
  for (let cur = e, hops = 0; cur && hops < 4; cur = (cur as { cause?: unknown }).cause, hops++) {
    if ((cur as { code?: unknown }).code === '23505') return true;
    const msg = (cur as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.includes('duplicate key value violates unique constraint')) {
      return true;
    }
  }
  return false;
}

/** Printable-ASCII, bounded. Rejected rather than ignored — a client that sent
 *  a key believes it bought idempotency, so silently dropping it is worse than
 *  a 400. */
const IDEMPOTENCY_RX = /^[\x21-\x7e]{8,200}$/;

export function readIdempotencyKey(
  req: Request,
): { ok: true; source: string | null } | { ok: false; response: Response } {
  const raw = req.headers.get('idempotency-key');
  if (!raw) return { ok: true, source: null };
  if (!IDEMPOTENCY_RX.test(raw)) {
    return {
      ok: false,
      response: apiError(
        'invalid_idempotency_key',
        400,
        'Idempotency-Key must be 8-200 printable ASCII characters.',
      ),
    };
  }
  // `api:` namespaces us away from the billing webhooks that already use
  // meta.source for grant rows (drizzle/0008's unique index spans both).
  return { ok: true, source: `api:${raw}` };
}

/**
 * The charge row for an idempotency source, or undefined. Uniqueness is
 * enforced by drizzle/0008's partial index
 * `credit_ledger_user_kind_source_uniq (user_id, kind, meta->>'source')
 *  WHERE meta ? 'source'` — this lookup only resolves what that index caught.
 *
 * `jsonb_exists` (not the `?` operator) so the planner can use the partial
 * index without the operator tripping over driver placeholder syntax.
 */
export async function findChargeBySource(userId: string, source: string) {
  const [row] = await db()
    .select({ id: creditLedger.id, credits: creditLedger.credits, meta: creditLedger.meta })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.userId, userId),
        eq(creditLedger.kind, 'charge'),
        sql`jsonb_exists(${creditLedger.meta}, 'source')`,
        sql`${creditLedger.meta}->>'source' = ${source}`,
      ),
    )
    .limit(1);
  return row;
}

/** Merge keys into a ledger row's meta without clobbering `source`. */
export async function patchChargeMeta(ledgerId: string, patch: Record<string, unknown>) {
  await db()
    .update(creditLedger)
    .set({ meta: sql`COALESCE(${creditLedger.meta}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(creditLedger.id, ledgerId));
}

/**
 * video_jobs.error is internal — it embeds the provider's name and a slice of
 * its response body. Collapse to a stable public code. Only meaningful for
 * rows whose status is already 'failed'.
 */
export function publicVideoError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith('charge_failed')) return 'charge_failed';
  if (raw.startsWith('submit_failed')) return 'generation_rejected';
  if (raw.startsWith('store_failed')) return 'storage_failed';
  if (raw === 'provider_stuck') return 'generation_timeout';
  return 'generation_failed';
}

/** 503s for the config that has to be present before we take money. */
export function providerPreflight(opts: { r2: boolean; piapi?: boolean; openai?: boolean }): Response | null {
  if (isStubMode.database()) {
    return apiError('service_unavailable', 503, 'The service is temporarily unavailable.');
  }
  if (opts.piapi && !process.env.PIAPI_API_KEY) {
    return apiError('service_unavailable', 503, 'Video generation is temporarily unavailable.');
  }
  if (opts.openai && !process.env.OPENAI_API_KEY) {
    return apiError('service_unavailable', 503, 'Image generation is temporarily unavailable.');
  }
  // R2 is a hard requirement, not a nice-to-have: a finished MP4 only lives on
  // the provider's CDN for a few hours. Without a bucket we'd charge the
  // caller, pay the provider, and have nowhere to put the result.
  if (opts.r2 && isStubMode.r2()) {
    return apiError('service_unavailable', 503, 'Media storage is temporarily unavailable.');
  }
  return null;
}

/**
 * Where PiAPI should push completions, or null to fall back to polling.
 *
 * Prefers NEXT_PUBLIC_APP_URL over the request's Host so a spoofed
 * x-forwarded-host on a non-Vercel deploy can't redirect our callbacks. https
 * only — PiAPI's Cloudflare workers cannot reach localhost, and a dev tunnel
 * that dies would silently strand jobs on the webhook path (the cron sweeper
 * still closes them out either way).
 */
export function webhookConfigFor(req: Request): { endpoint: string; secret: string } | undefined {
  const secret = process.env.PIAPI_WEBHOOK_SECRET ?? '';
  if (secret.length < 16) return undefined;
  let base = process.env.NEXT_PUBLIC_APP_URL || '';
  if (!base) {
    const host = req.headers.get('host');
    base = host ? `https://${host}` : '';
  }
  if (!base.startsWith('https://')) return undefined;
  return { endpoint: `${base.replace(/\/$/, '')}/api/piapi/webhook`, secret };
}

/** Submit failures where no HTTP response arrived, so PiAPI may still have
 *  accepted (and billed us for) the task. ENOTFOUND / ECONNREFUSED are NOT
 *  here: those never reached PiAPI, so they're definitive and refund now. */
const AMBIGUOUS_SUBMIT_RX = /ETIMEDOUT|ECONNRESET|ECONNABORTED|EPIPE|socket hang up/i;

export type SubmitVideoArgs = {
  auth: ApiKeyAuth;
  prompt: string;
  durationSec: number;
  quality: VideoQuality;
  aspect: SeedanceAspect;
  fast: boolean;
  /** `api:<Idempotency-Key>`, or null when the caller opted out. */
  source: string | null;
  webhookConfig?: { endpoint: string; secret: string };
};

export type SubmitVideoResult = { job: VideoJob; creditsCharged: number; replayed: boolean };

/**
 * Submit one text-to-video generation. Preserves every invariant of the
 * first-party route:
 *
 *   row insert → charge → provider submit
 *
 * so an accepted-but-unacked task can never be an invisible provider bill: the
 * video_jobs row (and its charge) always exist before PiAPI can bill us, and
 * meta.videoJobId cross-links the two. An ambiguous submit failure is left
 * pending and task-id-less for the cron sweeper to close out after its grace
 * window; a definitive rejection refunds immediately.
 *
 * `count` is deliberately absent — one job per request keeps Idempotency-Key a
 * 1:1 mapping onto one charge row. Callers wanting N clips loop N times with N
 * keys.
 */
export async function submitVideo(args: SubmitVideoArgs): Promise<SubmitVideoResult> {
  const { auth, source } = args;

  // Fast path: a retry whose original charge already landed. Authority is the
  // unique index below, not this read — it just spares us an orphan job row.
  if (source) {
    const replay = await replayOf(auth.userId, source);
    if (replay) return replay;
  }

  const perJob = priceForVideo({ durationSec: args.durationSec, quality: args.quality, fast: args.fast });

  // Pre-flight so a zero-balance key doesn't write two rows per 402. `charge`
  // below is still the authority (it re-checks under FOR UPDATE), so this is
  // purely about not amplifying a refused request into database writes.
  const pre = await ensureBalance(auth.userId, perJob.credits);
  if (!pre.ok) throw new InsufficientCreditsError(pre.balance, pre.needed);

  // providerTaskId '' = "not submitted yet"; finalizeVideoJob and the cron
  // sweeper both treat it as the ambiguous state.
  const [row] = await db()
    .insert(videoJobs)
    .values({
      userId: auth.userId,
      provider: args.fast ? 'piapi-seedance-2-fast' : 'piapi-seedance-2',
      providerTaskId: '',
      status: 'pending',
      prompt: args.prompt,
      rewrittenPrompt: null,
      durationSec: args.durationSec,
      aspect: args.aspect,
      quality: args.quality,
      genMode: 'text',
    })
    .returning();

  let charged;
  try {
    charged = await charge({
      userId: auth.userId,
      action: perJob.action,
      credits: perJob.credits,
      meta: {
        videoJobId: row.id,
        // MANDATORY: the auth layer's daily-cap query reads meta.apiKeyId.
        // Omitting it silently disables the spend cap.
        apiKeyId: auth.apiKeyId,
        durationSec: args.durationSec,
        quality: args.quality,
        aspect: args.aspect,
        fast: args.fast,
        genMode: 'text',
        via: 'api_v1',
        ...(source ? { source } : {}),
      },
    });
  } catch (e) {
    // Close the row either way so it doesn't sit pending forever.
    await db()
      .update(videoJobs)
      .set({
        status: 'failed',
        error: isUniqueViolation(e) ? 'duplicate_request' : 'charge_failed',
        updatedAt: new Date(),
      })
      .where(eq(videoJobs.id, row.id));
    // The unique index fired: this (user, Idempotency-Key) already charged, by
    // an in-flight twin or an earlier retry. Return the original job, never a
    // second charge.
    if (source && isUniqueViolation(e)) {
      const replay = await replayOf(auth.userId, source);
      if (replay) return replay;
    }
    throw e;
  }

  await db()
    .update(videoJobs)
    .set({ creditLedgerId: charged.ledgerId, creditsCharged: perJob.credits, updatedAt: new Date() })
    .where(eq(videoJobs.id, row.id));

  try {
    const taskId = await createSeedanceTask({
      prompt: args.prompt,
      mode: 'text_to_video',
      durationSec: args.durationSec,
      aspect: args.aspect,
      resolution: args.quality,
      fast: args.fast,
      apiKey: process.env.PIAPI_API_KEY!,
      webhookConfig: args.webhookConfig,
    });
    const [live] = await db()
      .update(videoJobs)
      .set({ providerTaskId: taskId, updatedAt: new Date() })
      .where(eq(videoJobs.id, row.id))
      .returning();
    return { job: live, creditsCharged: perJob.credits, replayed: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (AMBIGUOUS_SUBMIT_RX.test(msg)) {
      // No HTTP response came back, so we can't tell whether PiAPI took the
      // task. Leave it pending and task-id-less; the sweeper refunds after
      // SUBMIT_GRACE_MS. The caller sees a normal 202 and polls.
      await db()
        .update(videoJobs)
        .set({ error: `submit_unconfirmed: ${msg.slice(0, 160)}`, updatedAt: new Date() })
        .where(eq(videoJobs.id, row.id));
      return { job: row, creditsCharged: perJob.credits, replayed: false };
    }
    await db()
      .update(videoJobs)
      .set({ status: 'failed', error: `submit_failed: ${msg.slice(0, 200)}`, updatedAt: new Date() })
      .where(eq(videoJobs.id, row.id));
    try {
      await refund({ userId: auth.userId, ledgerId: charged.ledgerId, reason: `submit_failed: ${msg.slice(0, 80)}` });
    } catch (re) {
      console.warn('[v1/videos] refund failed:', re instanceof Error ? re.message : re);
    }
    throw e;
  }
}

/** Resolve an idempotency source back to the job its original charge created. */
async function replayOf(userId: string, source: string): Promise<SubmitVideoResult | null> {
  const original = await findChargeBySource(userId, source);
  const jobId = (original?.meta as { videoJobId?: unknown } | null)?.videoJobId;
  if (!original || typeof jobId !== 'string') return null;
  const [job] = await db()
    .select()
    .from(videoJobs)
    .where(and(eq(videoJobs.id, jobId), eq(videoJobs.userId, userId)))
    .limit(1);
  if (!job) return null;
  return { job, creditsCharged: Math.abs(original.credits), replayed: true };
}
