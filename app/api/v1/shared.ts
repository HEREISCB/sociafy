import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { and, eq, gt, ne, notInArray, sql } from 'drizzle-orm';
import type { ApiKeyAuth } from '../../../lib/api-key';
import { db } from '../../../lib/db';
import { creditLedger, genJobs, mediaAssets, videoJobs } from '../../../lib/db/schema';
import { isStubMode } from '../../../lib/env';
import { charge, ensureBalance, InsufficientCreditsError, refund } from '../../../lib/credits/ledger';
import { priceForVideo, type CreditAction, type ImageQuality, type ImageSize, type VideoQuality } from '../../../lib/credits/pricing';
import { imageFormat, type ImageFormat } from '../../../lib/media/probe';
import { createSeedanceTask, type SeedanceAspect, type SeedanceMode } from '../../../lib/ai/piapi';
import { createCueRender, priceCinemaRender, CUE_CONCURRENCY } from '../../../lib/ai/cue';
import { backendFor, type VideoModelId } from '../../../lib/ai/models';
import { getOpenAI, MODELS } from '../../../lib/ai/client';
import { makeMediaKey, publicUrlFor, uploadBuffer } from '../../../lib/storage/r2';

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
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: code, message, ...extra }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Strict UUID, not `[0-9a-f-]{36}`: the loose form admits 36-char strings that
 * Postgres refuses to cast to uuid, and that cast throws inside the query so
 * `withApiKey` renders a 500 for what is really a 404. Same reason
 * app/api/keys/[id] has its own copy.
 */
export const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Printable-ASCII (space excluded — 0x20 is not in the range), bounded.
 *  Rejected rather than ignored — a client that sent a key believes it bought
 *  idempotency, so silently dropping it is worse than a 400. */
const IDEMPOTENCY_RX = /^[\x21-\x7e]{8,200}$/;

export function readIdempotencyKey(
  req: Request,
  /** Endpoint discriminator. Without it one raw key reused across /videos and
   *  /images collides on the unique index: the second endpoint either 409s
   *  forever or resolves to a row of the wrong type. Scoping makes the key mean
   *  "this request on this endpoint", which is what callers assume. */
  scope: 'videos' | 'images',
): { ok: true; source: string | null } | { ok: false; response: Response } {
  const raw = req.headers.get('idempotency-key');
  if (!raw) return { ok: true, source: null };
  if (!IDEMPOTENCY_RX.test(raw)) {
    return {
      ok: false,
      response: apiError(
        'invalid_idempotency_key',
        400,
        'Idempotency-Key must be 8-200 printable ASCII characters, excluding space.',
      ),
    };
  }
  // `api:` namespaces us away from the billing webhooks that already use
  // meta.source for grant rows (drizzle/0008's unique index spans both).
  return { ok: true, source: `api:${scope}:${raw}` };
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
 * Give up an idempotency claim after a definitively failed, refunded attempt.
 *
 * The charge row is append-only and stays for audit; only its hold on
 * `credit_ledger_user_kind_source_uniq` is released, by moving `source` aside to
 * `releasedSource`. Without this a failed generation poisons its
 * Idempotency-Key forever: the row still matches the index, so every retry gets
 * 409 request_in_progress and the documented "retry the same key" can never
 * work.
 *
 * MANDATORY: only call once the refund is confirmed. A released source lets the
 * next retry charge again — if the first charge is still standing, that is a
 * double bill, which is exactly what the unique index exists to prevent.
 */
export async function releaseIdempotencySource(ledgerId: string) {
  await db()
    .update(creditLedger)
    .set({
      // `::text` because jsonb has `- text`, `- text[]` and `- integer`
      // overloads; an untyped literal makes the operator ambiguous.
      meta: sql`(COALESCE(${creditLedger.meta}, '{}'::jsonb) - 'source'::text)
                || jsonb_build_object('releasedSource', ${creditLedger.meta}->'source')`,
    })
    .where(eq(creditLedger.id, ledgerId));
}

/**
 * video_jobs.error is internal — it embeds the provider's name and a slice of
 * its response body. Collapse to a stable public code. Only meaningful for
 * rows whose status is already 'failed'.
 *
 * Every branch here is a documented code in docs/api.md §8. The fallthrough is
 * deliberately last-resort: a state the docs describe as its own failure mode
 * must map to its own code, or the caller cannot tell "we never reached the
 * provider" from "the model produced nothing".
 */
export function publicVideoError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith('submit_failed')) return 'generation_rejected';
  // Socket died mid-submit; refunded by the sweeper after its grace window.
  if (raw.startsWith('submit_unconfirmed')) return 'submit_unconfirmed';
  if (raw.startsWith('store_failed')) return 'storage_failed';
  if (raw.startsWith('provider_stuck')) return 'generation_timeout';
  // An Idempotency-Key twin won the charge race; this row never ran.
  if (raw.startsWith('duplicate_request')) return 'duplicate_request';
  // charge_failed is internal only: that path rethrows, so the caller gets a
  // 402/502/500 and never learns this job id. Not in the public table.
  if (raw.startsWith('charge_failed')) return 'generation_failed';
  // The provider ran the job and refused it. A content-policy refusal is the
  // caller's prompt and gets the same code the image path uses, so one code
  // means one thing across the API; anything else is ours or the model's. The
  // prose is the provider's and never leaves this process — logged, per rule 1.
  if (raw.startsWith('piapi_failed')) {
    console.error('[v1/videos] provider reported a failed job:', raw.slice(0, 300));
    return MODERATION_MSG_RX.test(raw) ? 'prompt_rejected' : 'generation_failed';
  }
  // Cinema. Same two outcomes, same two codes — one code means one thing across
  // the API regardless of which engine served the model. The backend's own
  // prose stays in the log; `cinema_refused` is set by us, not echoed.
  if (raw.startsWith('cinema_refused')) return 'prompt_rejected';
  if (raw.startsWith('cinema_failed')) {
    console.error('[v1/videos] cinema backend reported a failed render:', raw.slice(0, 300));
    return MODERATION_MSG_RX.test(raw) ? 'prompt_rejected' : 'generation_failed';
  }
  return 'generation_failed';
}

/**
 * A submitVideo failure the route can answer truthfully. Anything NOT wrapped
 * in this escapes as a generic 500 — which is correct, because "the provider
 * rejected the request" is a lie about a database error, and the old catch-all
 * told every caller their credits were never charged when in fact they were
 * charged and then refunded.
 */
export class SubmitFailure extends Error {
  constructor(
    readonly code: 'provider_rejected' | 'request_in_progress' | 'at_capacity' | 'prompt_rejected',
    /** Whether the charge was successfully reversed before we gave up. */
    readonly refunded: boolean,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'SubmitFailure';
  }
}

/**
 * Classify an image-provider failure into whose fault it is.
 *
 * This exists because the previous code mapped *any* provider HTTP 400 to
 * `prompt_rejected` "rejected by the content filter". An unknown model, an
 * unsupported parameter and an unverified account all arrive as 400s, so a
 * misconfiguration on our side read as the caller's prompt being obscene — and
 * every single request failed that way, including the docs' own example.
 *
 * Fails closed toward blaming ourselves: we only say `prompt_rejected` when the
 * provider actually said moderation. Anything we can't positively identify is
 * ours.
 *
 * Shape verified against node_modules/openai/core/error.js: APIError carries
 * `status`, `code`, `param`, `type` (lifted from the response body's `error`
 * object) and `error` (that body). Non-SDK callers can attach the same fields.
 */
const MODERATION_SIGNALS = new Set([
  'moderation_blocked',
  'content_policy_violation',
  'content_filter',
  'image_generation_user_error',
  'invalid_prompt',
]);
/**
 * Refusals sometimes arrive with a null code and only prose. Consulted on an
 * image 400 and on a failed video job (publicVideoError), and only for phrases a
 * provider uses exclusively for a content refusal — the wording is prose and
 * changes without notice, so match defensively but never on a phrase an
 * infrastructure failure could also contain. `prompt_rejected` tells the caller
 * to change their prompt, which is a lie if the provider merely fell over.
 */
const MODERATION_MSG_RX =
  /safety system|content polic|community guidelines|moderation|sensitive content|nsfw|prohibited content|not allowed by our|rejected as a result of/i;

export type ImageFailure = { code: string; status: number; message: string };

export function classifyImageFailure(e: unknown): ImageFailure {
  const o = (e ?? {}) as {
    status?: unknown;
    code?: unknown;
    type?: unknown;
    message?: unknown;
    error?: { code?: unknown; type?: unknown; message?: unknown } | null;
  };
  const status = typeof o.status === 'number' ? o.status : 0;
  const code = String(o.code ?? o.error?.code ?? '');
  const type = String(o.type ?? o.error?.type ?? '');
  const message = String(o.error?.message ?? o.message ?? '');

  if (MODERATION_SIGNALS.has(code) || MODERATION_SIGNALS.has(type)) {
    return {
      code: 'prompt_rejected',
      status: 400,
      message: 'The prompt was rejected by the content filter. Credits were refunded.',
    };
  }
  if (status === 400 && MODERATION_MSG_RX.test(message)) {
    return {
      code: 'prompt_rejected',
      status: 400,
      message: 'The prompt was rejected by the content filter. Credits were refunded.',
    };
  }
  // Our credentials, our billing, our account standing. 503 reads truer than
  // 502 — nothing about the request is wrong and retrying later may work.
  if (status === 401 || status === 403 || code === 'insufficient_quota' || code === 'billing_hard_limit_reached') {
    return {
      code: 'service_unavailable',
      status: 503,
      message: 'Image generation is temporarily unavailable. Credits were refunded. This is not a problem with your request.',
    };
  }
  // A request the provider understood and refused for reasons that are ours to
  // fix: unknown model, unsupported parameter, model not enabled for us.
  if (status === 400 || status === 404 || status === 422) {
    return {
      code: 'configuration_error',
      status: 502,
      message: 'Image generation is misconfigured on our side and has been logged. Credits were refunded. Your request was valid — retrying will not help until we fix it.',
    };
  }
  // Includes storage and database faults after a successful generation, which is
  // why the message does not claim the provider failed.
  return {
    code: 'upstream_error',
    status: 502,
    message: 'The image could not be generated or delivered. Credits were refunded.',
  };
}

/** One error-level line with the provider's real code and message, so a
 *  configuration_error is diagnosable from logs alone. Never returned to the
 *  caller — see rule 1 at the top of this file. */
export function logImageFailure(tag: string, e: unknown, classified: ImageFailure) {
  const o = (e ?? {}) as {
    status?: unknown;
    code?: unknown;
    type?: unknown;
    param?: unknown;
    message?: unknown;
    requestID?: unknown;
  };
  console.error(
    `[${tag}] image generation failed → ${classified.code}`,
    JSON.stringify({
      status: o.status ?? null,
      code: o.code ?? null,
      type: o.type ?? null,
      param: o.param ?? null,
      requestId: o.requestID ?? null,
      message: String(o.message ?? '').slice(0, 500),
    }),
  );
}

/** 503s for the config that has to be present before we take money. */
export function providerPreflight(opts: { r2: boolean; piapi?: boolean; cue?: boolean; openai?: boolean }): Response | null {
  if (isStubMode.database()) {
    return apiError('service_unavailable', 503, 'The service is temporarily unavailable.');
  }
  if (opts.piapi && !process.env.PIAPI_API_KEY) {
    return apiError('service_unavailable', 503, 'Video generation is temporarily unavailable.');
  }
  if (opts.cue && isStubMode.cue()) {
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

/**
 * The modes v1 offers. Reference *video* is absent on purpose: it alone carries
 * the per-input-second surcharge we cannot price (COSTS.md:77). Values match the
 * first-party route's genMode so video_jobs.gen_mode stays one vocabulary.
 */
export type VideoGenMode = 'text' | 'reference' | 'image-to-video';

/** Our vocabulary → the provider's. `imageUrls` for first_last_frames is
 *  [start, ...end?]; for omni_reference it is the reference set. */
const SEEDANCE_MODE: Record<VideoGenMode, SeedanceMode> = {
  text: 'text_to_video',
  reference: 'omni_reference',
  'image-to-video': 'first_last_frames',
};

/**
 * Cinema renders currently occupying a backend slot, account-wide.
 *
 * Bounded by age on purpose. A row that never reached a terminal state — a
 * submit whose socket died, a render the backend forgot — would otherwise hold
 * a slot forever and take the model offline for everyone. finalizeVideoJob
 * gives up on the same two-hour horizon and refunds, so anything older than
 * that is not really occupying anything.
 */
async function cinemaInFlight(): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(videoJobs)
    .where(
      and(
        eq(videoJobs.provider, 'cue-h3'),
        eq(videoJobs.status, 'pending'),
        gt(videoJobs.createdAt, new Date(Date.now() - 2 * 60 * 60_000)),
      ),
    );
  return Number(row?.n ?? 0);
}

export type SubmitVideoArgs = {
  auth: ApiKeyAuth;
  /** Public model id. Decides the backend, the price and the envelope. */
  model: VideoModelId;
  prompt: string;
  durationSec: number;
  quality: VideoQuality;
  aspect: SeedanceAspect;
  fast: boolean;
  genMode?: VideoGenMode;
  /** Stills for a non-text mode, already re-hosted by us — see rehostReferences.
   *  Order is meaningful for image-to-video. Motion only: Cinema takes bytes. */
  imageUrls?: string[];
  /** Cinema's equivalent: base64 stills keyed by SLOT, not by position —
   *  either may be absent, and a positional array would send a lone closing
   *  frame as the opening one. Already size-checked by the route. */
  frames?: { first?: string; last?: string };
  /** Cinema only: take the canvas shape from the frame rather than `aspect`. */
  matchFrameAspect?: boolean;
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
  const genMode: VideoGenMode = args.genMode ?? 'text';

  // Fast path: a retry whose original charge already landed. Authority is the
  // unique index below, not this read — it just spares us an orphan job row.
  if (source) {
    const replay = await replayOf(auth.userId, source);
    if (replay) return replay;
  }

  const isCinema = args.model === 'sociafy-cinema-1';
  const backend = backendFor(args.model, args.fast);

  // Cinema runs on a backend that admits three renders at a time ACROSS THE
  // WHOLE ACCOUNT — ours, shared by every customer, not one each. Check before
  // charging: a 429 after the charge is a refund we then have to explain.
  // ponytail: refuse, don't queue. A real queue needs a submit-later worker and
  // a job state our sweeper doesn't currently mean; add it when refusals show
  // up in the logs rather than in principle.
  if (isCinema) {
    const busy = await cinemaInFlight();
    if (busy >= CUE_CONCURRENCY) {
      throw new SubmitFailure('at_capacity', false, `cinema slots busy: ${busy}/${CUE_CONCURRENCY}`);
    }
  }

  // Cinema is quoted per request, not looked up in a bucket: its cost is
  // quadratic-ish in frame count, so there is no 8s row to scale off.
  let perJob: { action: CreditAction; credits: number };
  let cinema: { megapixels: number; steps: number } | null = null;
  if (isCinema) {
    try {
      const q = await priceCinemaRender({
        durationSec: args.durationSec,
        quality: args.quality as '480p' | '720p',
      });
      perJob = { action: 'video_cinema', credits: q.credits };
      cinema = { megapixels: q.megapixels, steps: q.steps };
    } catch (e) {
      // We could not get a price. Refuse rather than guess — a guess is either
      // below our own cost or an overcharge for our outage. Nothing is charged.
      console.error('[submitVideo] cinema quote failed:', e instanceof Error ? e.message : e);
      throw new SubmitFailure('provider_rejected', false, 'cinema quote unavailable');
    }
  } else {
    perJob = priceForVideo({ durationSec: args.durationSec, quality: args.quality, fast: args.fast });
  }

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
      provider: backend,
      providerTaskId: '',
      status: 'pending',
      prompt: args.prompt,
      rewrittenPrompt: null,
      durationSec: args.durationSec,
      aspect: args.aspect,
      quality: args.quality,
      genMode,
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
        model: args.model,
        durationSec: args.durationSec,
        quality: args.quality,
        aspect: args.aspect,
        fast: args.fast,
        genMode,
        // Reference stills carry no surcharge (COSTS.md prices only reference
        // *video* input), so this explains the mode, not the price.
        ...(args.imageUrls?.length ? { referenceImages: args.imageUrls.length } : {}),
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
      // Charged under this key but no job resolves from it yet — a twin is
      // mid-flight. 409, not a second charge and not a fake provider rejection.
      throw new SubmitFailure('request_in_progress', false, 'charge exists, job unresolved');
    }
    throw e; // InsufficientCreditsError or a DB fault: not a provider rejection.
  }

  await db()
    .update(videoJobs)
    .set({ creditLedgerId: charged.ledgerId, creditsCharged: perJob.credits, updatedAt: new Date() })
    .where(eq(videoJobs.id, row.id));

  try {
    const taskId = cinema
      ? await createCueRender({
          prompt: args.prompt,
          durationSec: args.durationSec,
          megapixels: cinema.megapixels,
          steps: cinema.steps,
          aspect: args.aspect,
          firstFrame: args.frames?.first,
          lastFrame: args.frames?.last,
          matchInput: args.matchFrameAspect,
          title: args.prompt.slice(0, 80),
        })
      : await createSeedanceTask({
          prompt: args.prompt,
          mode: SEEDANCE_MODE[genMode],
          imageUrls: args.imageUrls,
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
    let refunded = false;
    try {
      refunded = (await refund({
        userId: auth.userId,
        ledgerId: charged.ledgerId,
        reason: `submit_failed: ${msg.slice(0, 80)}`,
        // So a refund row can be reconciled against the job that caused it.
        meta: { videoJobId: row.id },
      })).refunded;
    } catch (re) {
      console.warn('[v1/videos] refund failed:', re instanceof Error ? re.message : re);
    }
    // The source is deliberately NOT released here (unlike /images). The charge
    // row keeps meta.videoJobId, so a retry with the same key replays the failed
    // job and its public error code — informative, and it preserves "same key,
    // never a second charge". A caller who wants another attempt uses a new key;
    // docs/api.md §7 says so.
    throw new SubmitFailure('provider_rejected', refunded, msg);
  }
}

// =====================================================
// Reference images for POST /images
// =====================================================

/**
 * Limits on caller-supplied reference images. /images is a public,
 * money-spending endpoint and each URL is an SSRF surface, so every one of these
 * is mandatory — but none of them is about price any more: the surcharge is flat
 * per reference (see image_reference in lib/credits/pricing.ts), so dimensions
 * and bytes no longer affect the bill. What is left is memory and latency.
 *
 * 20MB per image clears catalogue masters (the provider's own limit is <50MB) and
 * 48MB across the whole set bounds the buffered total, since we hold every
 * reference in memory at once. That byte ceiling and the fetch budget — not the
 * count — are what actually protect the route: ten 4MB references cost strictly
 * less memory and less time than four 20MB ones, so capping the count low was
 * punishing the common good case without lowering the worst case.
 */
export const REFERENCE_LIMITS = {
  /** Images. NOT a provider limit: OpenAI's images/edits accepted 20 references
   *  in one call when probed directly. This is our memory/latency budget. */
  maxImages: 10,
  /** Video. This one IS the provider's, and it is hard: Seedance answers
   *  `400 invalid request: omni_reference mode accepts at most 9 reference
   *  images, got 10`. Verified against PiAPI, not inferred from docs. */
  maxVideoImages: 9,
  maxBytes: 20 * 1024 * 1024,
  /** All references together — the real ceiling. maxImages × maxBytes of
   *  buffered memory is not acceptable, so the bytes bound it, not the count. */
  maxTotalBytes: 48 * 1024 * 1024,
  perFetchMs: 20_000,
  /** All fetches together. Slow hosts must not eat the route's maxDuration
   *  and strand us mid-generation after the charge. */
  totalBudgetMs: 45_000,
} as const;

const mb = (bytes: number) => bytes / 1024 / 1024;

/** The only content types we accept, mapped to the magic-byte format that must
 *  back them up. `image/jpg` is deliberately absent — it isn't a real type. */
const REFERENCE_TYPES: Record<string, ImageFormat> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};

/**
 * Destinations a caller must never be able to point us at: loopback, private,
 * link-local (169.254.169.254 is the cloud metadata endpoint), CGNAT, multicast
 * and reserved space. `node:net`'s BlockList does the subnet arithmetic — and
 * critically, `check(addr, 'ipv6')` matches IPv4-mapped forms like
 * `::ffff:169.254.169.254` against the IPv4 rules, which the hand-rolled
 * dotted-quad regex in lib/ai/skills/fetch-url.ts does not.
 */
const BLOCKED_HOSTS = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  BLOCKED_HOSTS.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) {
  BLOCKED_HOSTS.addSubnet(net, bits, 'ipv6');
}

/**
 * Whether every address `host` resolves to is public.
 *
 * Resolving first is what closes the integer/hex/shorthand IPv4 bypasses
 * (`https://2130706433/`, `https://0x7f000001/`, `https://127.1/`): getaddrinfo
 * normalises all of them to 127.0.0.1, which BlockList then catches. A literal
 * IP skips DNS. Any single private answer rejects the whole host — fail closed.
 *
 * ponytail: DNS rebinding is the residual hole. undici re-resolves when it
 * connects, so a TTL-0 record can answer public here and private there. Closing
 * it needs a pinned-IP connect (custom undici Agent with `connect.lookup`, or a
 * dispatcher bound to the vetted address); the whole class also goes away if
 * references are moved behind an egress proxy.
 */
async function isPublicHost(hostname: string): Promise<boolean> {
  // URL keeps IPv6 literals bracketed; isIP does not accept the brackets.
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  const literal = isIP(host);
  let addrs: { address: string; family: number }[];
  if (literal) {
    addrs = [{ address: host, family: literal }];
  } else {
    try {
      addrs = await lookup(host, { all: true });
    } catch {
      return false;
    }
  }
  if (!addrs.length) return false;
  return !addrs.some((a) => BLOCKED_HOSTS.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'));
}

/** Body up to `maxBytes`, or null if it exceeds that. Empty body → empty buffer
 *  (the format sniff rejects it), so null means "too large" and nothing else. */
async function readCapped(resp: Response, maxBytes: number): Promise<Buffer | null> {
  // content-length is a cheap early out only: it is absent on chunked responses
  // and freely lied about, so the streaming counter below is the real cap.
  if (Number(resp.headers.get('content-length') ?? 0) > maxBytes) {
    await resp.body?.cancel().catch(() => {});
    return null;
  }
  const reader = resp.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export type ReferenceFetch =
  | { ok: true; files: File[] }
  | { ok: false; response: Response };

/**
 * Fetch and validate reference images for images.edit.
 *
 * Every failure here is the caller's input, so each gets its own 400 code and an
 * actionable message — never `prompt_rejected`, and never a charge: this runs
 * before the ledger is touched.
 *
 * Checks, in order and all mandatory: https only, no private/loopback/metadata
 * destination, no redirects, an accepted content-type, magic bytes that agree
 * with it, and a streamed byte cap (per image and across all of them). A URL on
 * our own R2 public base is not special-cased — it takes the identical path,
 * because "we host it" says nothing about its bytes.
 */
export async function fetchReferenceImages(urls: string[]): Promise<ReferenceFetch> {
  const deadline = Date.now() + REFERENCE_LIMITS.totalBudgetMs;
  const files: File[] = [];
  let bytes = 0;

  for (const [i, raw] of urls.entries()) {
    const bad = (code: string, message: string) =>
      ({ ok: false as const, response: apiError(code, 400, message, { reference_url: raw }) });

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return bad('reference_url_rejected', 'Each reference_images entry must be an absolute https:// URL.');
    }
    if (url.protocol !== 'https:') {
      return bad('reference_url_rejected', 'Reference images must be served over https. http:// and other schemes are refused.');
    }
    if (!(await isPublicHost(url.hostname))) {
      return bad('reference_url_rejected', 'That host does not resolve to a public internet address, so we will not fetch it.');
    }

    const budget = Math.min(REFERENCE_LIMITS.perFetchMs, deadline - Date.now());
    if (budget <= 0) {
      return bad('reference_unfetchable', 'Fetching the reference images ran out of time. Serve them from a faster host, or send fewer.');
    }

    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { 'User-Agent': 'sociafy/1.0', Accept: 'image/png,image/jpeg,image/webp' },
        // Never follow: re-validating each hop is the part URL fetchers get
        // wrong (fetch-url.ts validates only the first URL and then follows
        // anywhere), and a product photo does not need a redirect.
        redirect: 'manual',
        signal: AbortSignal.timeout(budget),
        cache: 'no-store',
      });
    } catch {
      return bad('reference_unfetchable', `We could not fetch that URL. It must be publicly reachable within ${REFERENCE_LIMITS.perFetchMs / 1_000} seconds.`);
    }

    // status 0 is an opaque-redirect filtered response — same answer as a 3xx.
    if (resp.status === 0 || (resp.status >= 300 && resp.status < 400)) {
      return bad('reference_url_rejected', 'That URL redirects, and we do not follow redirects. Send the final image URL.');
    }
    if (!resp.ok) {
      return bad('reference_unfetchable', `That URL answered ${resp.status}. It must return the image itself, with no authentication.`);
    }

    const declared = (resp.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const expected = REFERENCE_TYPES[declared];
    if (!expected) {
      await resp.body?.cancel().catch(() => {});
      return bad('reference_type_unsupported', 'Reference images must be image/png, image/jpeg or image/webp.');
    }

    // One cap, whichever binds first: what is left of the shared budget, never
    // more than one image's own allowance. Both are enforced by the streaming
    // counter, so a missing or dishonest content-length changes nothing.
    const body = await readCapped(resp, Math.min(REFERENCE_LIMITS.maxBytes, REFERENCE_LIMITS.maxTotalBytes - bytes));
    if (!body) {
      return bad('reference_too_large', `Each reference image must be under ${mb(REFERENCE_LIMITS.maxBytes)} MB, and all of them together under ${mb(REFERENCE_LIMITS.maxTotalBytes)} MB.`);
    }
    bytes += body.length;
    // The bytes decide, not the header the caller's server chose to send.
    if (imageFormat(body) !== expected) {
      return bad('reference_type_unsupported', `That file is not really ${declared} — its content-type and its actual bytes disagree.`);
    }
    files.push(
      // Uint8Array, not the Buffer itself: Blob's types only accept a view over
      // a plain ArrayBuffer.
      new File([new Uint8Array(body)], `reference-${i + 1}.${expected === 'jpeg' ? 'jpg' : expected}`, {
        type: declared,
      }),
    );
  }

  return { ok: true, files };
}

/**
 * Copy vetted references into our own bucket and return OUR urls, in order.
 *
 * Used by /videos, where the references are handed to the generation provider
 * rather than uploaded in the request body. We never forward a caller's URL: a
 * signed or private one fails opaquely on their side after we have charged, and
 * a customer's own host is not ours to disclose to a third party. The bytes are
 * already vetted here — fetchReferenceImages is the trust boundary.
 */
export async function rehostReferences(userId: string, files: File[]): Promise<string[]> {
  return Promise.all(
    files.map(async (file) => {
      const key = makeMediaKey(userId, `api-ref-${Date.now()}-${file.name}`);
      await uploadBuffer({ key, body: Buffer.from(await file.arrayBuffer()), contentType: file.type });
      return publicUrlFor(key);
    }),
  );
}

// =====================================================
// Async image jobs for POST /images (`async: true`)
// =====================================================

export type ImageJob = typeof genJobs.$inferSelect;

/** gen_jobs.kind for these rows. Part of every lookup's WHERE clause, so a tts
 *  or avatar job can never surface through the images endpoints. */
export const IMAGE_JOB_KIND = 'image';

/** What runImageJob needs, persisted for the sweeper and for debugging. `source`
 *  is here so a failed job can release its Idempotency-Key exactly as the
 *  synchronous path does — see failImageJob. */
export type ImageJobInput = {
  prompt: string;
  size: ImageSize;
  quality: ImageQuality;
  referenceCount: number;
  source: string | null;
};

/**
 * The pending gen_jobs row for an async /images request. Written BEFORE the
 * charge — submitVideo's discipline for the same reason: a charge must never
 * exist without a row explaining it, because that row is both what the caller
 * polls and what the sweeper refunds against.
 *
 * `provider_call_id` is NOT NULL and OpenAI's images API returns no job id of its
 * own, so the row's own id goes there: unique, meaningful, and it keeps
 * gen_jobs_call_idx a useful index instead of a column of empty strings.
 */
export async function insertImageJob(userId: string, input: ImageJobInput): Promise<ImageJob> {
  const id = randomUUID();
  const [row] = await db()
    .insert(genJobs)
    .values({
      id,
      userId,
      kind: IMAGE_JOB_KIND,
      provider: 'openai-images',
      providerCallId: id,
      status: 'pending',
      inputJson: input,
      // creditsCharged stays null until the charge lands, like videoJobs — a row
      // whose charge failed must not report a price it never took.
    })
    .returning();
  return row;
}

/**
 * Generate, store and close out one async image job.
 *
 * Runs inside `after()`, so the caller is already gone and the row IS the answer:
 * every exit has to leave it terminal with the money settled, and nothing may
 * throw out of here — an unhandled rejection would strand a pending row and its
 * charge until the cron sweeper's grace window expires.
 */
export async function runImageJob(job: ImageJob, refs: File[] | null): Promise<void> {
  const { prompt, size, quality } = job.inputJson as ImageJobInput;
  try {
    const openai = getOpenAI();
    if (!openai) throw new Error('openai_not_configured');
    // Same two calls with the same arguments as the synchronous path — see the
    // comment there for why input_fidelity is not sent.
    const res = refs
      ? await openai.images.edit(
          { model: MODELS.image, image: refs, prompt, size, quality, n: 1 },
          { maxRetries: 0 },
        )
      : await openai.images.generate(
          { model: MODELS.image, prompt, size, quality, n: 1 },
          { maxRetries: 0 },
        );
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new Error('no_image_returned');

    const buf = Buffer.from(b64, 'base64');
    const key = makeMediaKey(job.userId, `api-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
    // Upload BEFORE claiming the row: a row claimed 'completed' with no asset is
    // a zombie the caller polls forever.
    await uploadBuffer({ key, body: buf, contentType: 'image/png' });
    await completeImageJob(job, key, buf.length);
  } catch (e) {
    const failure = classifyImageFailure(e);
    logImageFailure('v1/images async', e, failure);
    // The public code is stored verbatim, so GET /images/{id} needs no
    // internal→public mapping step of its own to get wrong.
    await failImageJob(job, failure.code);
  }
}

/**
 * Claim the row and record the asset, in ONE transaction.
 *
 * MANDATORY: keep these three statements in a single transaction. As three
 * separate commits the row was briefly `status='completed'` with
 * `media_asset_id IS NULL`, and GET /api/v1/images/{id} answered `completed` with
 * `image_url: null` — an integrator believed that completion and threw away an
 * image they had already paid 6 credits for (production `no_image`). Committing
 * together makes status and asset visible together; nobody may "simplify" this
 * back into three statements.
 *
 * Only the finaliser whose conditional UPDATE matches inserts a media_assets
 * row, so a cron tick racing `after()` yields one asset and not two — the
 * protection finalizeVideoJob relies on, for the same reason. The loser inserts
 * nothing at all, so a lost race cannot leave an orphan asset in the user's
 * library either.
 *
 * The R2 upload deliberately stays outside (see runImageJob): a transaction must
 * never be held open across a network hop, least of all through a
 * transaction-mode pooler.
 */
async function completeImageJob(job: ImageJob, key: string, sizeBytes: number): Promise<void> {
  const { prompt, size } = job.inputJson as ImageJobInput;
  const [w, h] = size.split('x').map((n) => parseInt(n, 10));

  await db().transaction(async (tx) => {
    const claimed = await tx
      .update(genJobs)
      .set({ status: 'completed', error: null, updatedAt: new Date() })
      .where(and(eq(genJobs.id, job.id), ne(genJobs.status, 'completed')))
      .returning({ id: genJobs.id });
    // Lost the race — abort before inserting anything. Our R2 object is a
    // harmless orphan and the winner's asset is what the poll will read.
    if (claimed.length === 0) return;

    const [asset] = await tx
      .insert(mediaAssets)
      .values({
        userId: job.userId,
        storageKey: key,
        publicUrl: publicUrlFor(key),
        mimeType: 'image/png',
        sizeBytes,
        width: w,
        height: h,
        label: prompt.slice(0, 80),
      })
      .returning();

    await tx.update(genJobs).set({ mediaAssetId: asset.id, updatedAt: new Date() }).where(eq(genJobs.id, job.id));
  });
}

/**
 * Mark an image job failed and return its credits. The UPDATE is conditional on
 * the row not already being terminal and the refund only fires if we claimed it,
 * so the in-request finaliser and a cron sweep cannot double-refund.
 *
 * Releases the Idempotency-Key too, for the reason the synchronous path does: the
 * refund does not delete the charge row, so without this every retry of that key
 * is a permanent 409 and the documented "retry the same key" could never work.
 * Gated on the refund landing — releasing an unrefunded claim would let the retry
 * bill a second time.
 */
export async function failImageJob(job: ImageJob, error: string): Promise<void> {
  const claimed = await db()
    .update(genJobs)
    .set({ status: 'failed', error: error.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(genJobs.id, job.id), notInArray(genJobs.status, ['completed', 'failed'])))
    .returning({ id: genJobs.id });
  // No ledger row means the charge never landed (it is written after the row), so
  // there is nothing to give back.
  if (claimed.length === 0 || !job.creditLedgerId) return;

  let refunded = false;
  try {
    refunded = (await refund({
      userId: job.userId,
      ledgerId: job.creditLedgerId,
      reason: error.slice(0, 120),
    })).refunded;
  } catch (e) {
    console.warn('[v1/images] refund failed:', e instanceof Error ? e.message : e);
  }

  const source = (job.inputJson as ImageJobInput | null)?.source;
  if (source && refunded) {
    await releaseIdempotencySource(job.creditLedgerId);
  } else if (source) {
    console.error('[v1/images] refund not confirmed, keeping idempotency claim on', job.creditLedgerId);
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
