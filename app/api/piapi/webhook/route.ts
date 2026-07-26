import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { videoJobs } from '../../../../lib/db/schema';
import { isStubMode } from '../../../../lib/env';
import { rateLimit, requestIp } from '../../../../lib/rate-limit';
import { finalizeVideoJob } from '../../../../lib/media/finalizeVideoJob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Finalizing downloads the finished MP4 and re-uploads it to R2. PiAPI wants a
// fast 2xx and retries 3× at 5s intervals on anything else — those retries are
// harmless (finalizeVideoJob claims the row conditionally, so a retry racing
// the original produces one asset and one refund), and the cron sweeper closes
// out anything all four attempts miss.
// ponytail: doing the transfer inline instead of enqueueing it. Ceiling is
// PiAPI's retry budget on very large clips; add a queue only if the sweeper
// starts being the thing that finishes jobs.
export const maxDuration = 300;

/** Reject payloads older than this. PiAPI's own retries land within ~15s. */
const REPLAY_WINDOW_S = 300;

type PiapiWebhookBody = {
  timestamp?: unknown;
  data?: { task_id?: unknown; status?: unknown };
};

/**
 * POST /api/piapi/webhook — provider push notification for video tasks.
 *
 * Verified contract (https://piapi.ai/docs/unified-webhook):
 *   - Enabled per task via `config.webhook_config: { endpoint, secret }`.
 *   - PiAPI echoes `secret` back verbatim in the `x-webhook-secret` header. It
 *     is a shared bearer, NOT an HMAC over the body — so there is nothing to
 *     bind a payload to its signature, and the Unix `timestamp` replay window
 *     below is the only thing limiting a captured header's reuse.
 *   - Body is `{ timestamp, data: { task_id, model, status, output, error } }`,
 *     where `data` mirrors the polling response. Fires on completed / failed.
 *
 * This is a delivery *accelerator*, never the only path: /api/cron/
 * finalize-video-jobs remains the backstop, so a webhook that never arrives (or
 * a rotated secret) costs latency, not money.
 */
export async function POST(req: NextRequest) {
  const rl = rateLimit('webhook', `piapi:${requestIp(req.headers)}`);
  if (!rl.ok) {
    return new NextResponse('rate_limited', { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } });
  }

  // Fail closed. An unset or short secret would mean anyone who can guess a
  // task id could drive our finalize path, so we refuse rather than trust.
  const secret = process.env.PIAPI_WEBHOOK_SECRET ?? '';
  if (secret.length < 16) {
    console.warn('[piapi-webhook] PIAPI_WEBHOOK_SECRET unset or too short — refusing');
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }
  if (!secretMatches(req.headers.get('x-webhook-secret'), secret)) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }

  // Only now do we touch the body.
  const body = (await req.json().catch(() => null)) as PiapiWebhookBody | null;
  if (!body) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const ts = Number(body.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > REPLAY_WINDOW_S) {
    return NextResponse.json({ error: 'stale_timestamp' }, { status: 400 });
  }

  const taskId = body.data?.task_id;
  if (typeof taskId !== 'string' || !taskId) {
    return NextResponse.json({ error: 'missing_task_id' }, { status: 400 });
  }
  if (isStubMode.database()) return NextResponse.json({ ok: true, skipped: 'no_database' });

  const [job] = await db().select().from(videoJobs).where(eq(videoJobs.providerTaskId, taskId)).limit(1);
  // Unknown task: 2xx so PiAPI stops retrying, and no hint about what exists.
  if (!job) return NextResponse.json({ ok: true, ignored: true });

  // The status in the payload is advisory — finalizeVideoJob re-reads the task
  // from the provider. One reconcile path for the poller, the sweeper and this.
  try {
    const out = await finalizeVideoJob(job);
    return NextResponse.json({ ok: true, status: out.status });
  } catch (e) {
    console.error('[piapi-webhook] finalize failed:', e instanceof Error ? e.message : e);
    // Non-2xx invites PiAPI's retry, which is exactly what we want here.
    return NextResponse.json({ error: 'finalize_failed' }, { status: 500 });
  }
}

/** Constant-time compare behind a length pre-check (timingSafeEqual throws on
 *  a length mismatch, and the length itself is not a secret). */
function secretMatches(got: string | null, expected: string): boolean {
  if (!got || got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}
