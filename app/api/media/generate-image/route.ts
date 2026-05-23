import { NextRequest } from 'next/server';
import { z } from 'zod';
import * as https from 'node:https';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { db } from '../../../../lib/db';
import { mediaAssets } from '../../../../lib/db/schema';
import { getOpenAI, MODELS } from '../../../../lib/ai/client';
import { rewritePromptForMedia } from '../../../../lib/ai/prompt-rewriter';
import { loadBrandContext, renderBrandBlock } from '../../../../lib/ai/brand-context';
import { makeMediaKey, publicUrlFor, uploadBuffer } from '../../../../lib/storage/r2';
import { isStubMode } from '../../../../lib/env';
import { priceForImage } from '../../../../lib/credits/pricing';
import { ensureBalance, charge, refund, partialRefund, insufficientCreditsResponse } from '../../../../lib/credits/ledger';

/**
 * Direct https.request fallback to api.openai.com/v1/images/generations.
 *
 * Why: the OpenAI SDK uses native fetch → undici, which on Node 20+ defaults
 * to HTTP/2 with connection pooling. Some Windows antivirus / corporate
 * proxy stacks (Kaspersky, Bitdefender, Zscaler, etc.) intercept TLS and
 * mishandle either the H2 upgrade or the resumed sessions, returning SSL
 * alert 40 (handshake_failure). Going through node:https with keepAlive
 * disabled and an explicit TLS 1.2+ floor produces a clean, single-use
 * HTTP/1.1 handshake that those stacks almost always accept.
 *
 * Same JSON contract as the SDK so the rest of the route doesn't care.
 */
function generateImageDirect(args: {
  prompt: string;
  size: '1024x1024' | '1536x1024' | '1024x1536';
  quality: 'low' | 'medium' | 'high';
  apiKey: string;
}): Promise<{ data: Array<{ b64_json?: string }> }> {
  const body = JSON.stringify({
    model: MODELS.image,
    prompt: args.prompt,
    size: args.size,
    quality: args.quality,
    n: 1,
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        port: 443,
        path: '/v1/images/generations',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${args.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'sociafy/1.0',
          'Accept': 'application/json',
        },
        // TLS options MUST be on the Agent — when an explicit `agent` is
        // passed, request-level TLS options are silently ignored because
        // the socket is created by the agent's createConnection().
        // Verified the agent-level form via `node -e https.request(...)`:
        // TLS 1.3 trips "alert 40 handshake_failure" on this machine but
        // TLS 1.2 + http/1.1 ALPN + IPv4 succeeds (same path curl uses).
        agent: new https.Agent({
          keepAlive: false,
          minVersion: 'TLSv1.2',
          maxVersion: 'TLSv1.2',
          ALPNProtocols: ['http/1.1'],
          family: 4,
        }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`openai_${res.statusCode}: ${text.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      },
    );
    req.setTimeout(120_000, () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export const runtime = 'nodejs';
export const maxDuration = 90;

/**
 * GET /api/media/generate-image — TLS diagnostic.
 *
 * Tests each upstream host (OpenAI + the user's R2 endpoint) with both
 * Node's default TLS settings and our TLS 1.2 + http/1.1 + IPv4 cap.
 * api.openai.com worked on default — but the S3 SDK uses its own request
 * handler so R2 calls don't benefit from our OpenAI overrides, and that
 * was the actual broken hop.
 */
export async function GET() {
  const r2Host = `${process.env.R2_ACCOUNT_ID ?? 'unknown'}.r2.cloudflarestorage.com`;
  const hosts = [
    { host: 'api.openai.com', path: '/v1/models' },
    { host: r2Host, path: '/' },
  ];
  const agents = [
    { name: 'default', agent: new https.Agent({ keepAlive: false }) },
    { name: 'tls12+alpn-http1+ipv4', agent: new https.Agent({ keepAlive: false, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'], family: 4 }) },
  ];
  type Row = { host: string; agent: string; ok: boolean; status?: number; error?: string };
  const tasks: Array<Promise<Row>> = [];
  for (const h of hosts) for (const a of agents) {
    tasks.push(new Promise<Row>((resolve) => {
      const req = https.request({ hostname: h.host, port: 443, path: h.path, method: 'GET', agent: a.agent }, (res) => {
        res.resume();
        resolve({ host: h.host, agent: a.name, ok: true, status: res.statusCode });
      });
      req.setTimeout(15_000, () => req.destroy(new Error('timeout')));
      req.on('error', (e) => resolve({ host: h.host, agent: a.name, ok: false, error: `${(e as { code?: string }).code ?? ''} ${e.message}`.trim().slice(0, 200) }));
      req.end();
    }));
  }
  const results = await Promise.all(tasks);
  return Response.json({ results }, { headers: { 'cache-control': 'no-store' } });
}

const bodySchema = z.object({
  prompt: z.string().min(2).max(2_000),
  size: z.enum(['1024x1024', '1536x1024', '1024x1536']).default('1024x1024'),
  quality: z.enum(['low', 'medium', 'high']).default('medium'),
  count: z.number().int().min(1).max(4).default(1),
  /** Optional post caption — improves the rewriter's tone alignment. */
  caption: z.string().max(2_000).optional(),
  /** Skip the auto-rewriter (default false). */
  rawPrompt: z.boolean().default(false),
});

/**
 * POST /api/media/generate-image
 *
 * 1. Auto-enhances the user's loose prompt via the prompt-rewriter (loads
 *    lib/ai/skills/prompts/gpt-image-1.md into the system prompt).
 * 2. Generates `count` images in parallel via gpt-image-1.
 * 3. Uploads each PNG to R2 and inserts a media_assets row.
 *
 * Returns: { items: [...media_asset rows], rewrittenPrompt, enhanced }
 */
// Module-level so we can match networky errors anywhere — including inside
// uploadBuffer (R2) and the rewriter — without re-declaring the predicate.
const flattenErr = (e: unknown, depth = 0): string => {
  if (!e || depth > 6) return '';
  if (typeof e === 'string') return e;
  const o = e as { name?: string; message?: string; code?: string; cause?: unknown; errors?: unknown[] };
  let out = `${o.name ?? ''} ${o.message ?? ''} ${o.code ?? ''}`;
  if (o.cause) out += ' ' + flattenErr(o.cause, depth + 1);
  if (Array.isArray(o.errors)) for (const sub of o.errors) out += ' ' + flattenErr(sub, depth + 1);
  return out;
};
const NETWORK_RX = /EPROTO|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|handshake|alert number 40|APIConnectionError|Connection error|fetch failed|UND_ERR/i;
const isNetworkErr = (e: unknown) => NETWORK_RX.test(flattenErr(e));

export async function POST(req: NextRequest) {
  console.log('[generate-image] route invoked — v7 (step labels in errors)');
  return withUser(async (user) => {
    let step: 'init' | 'rewrite' | 'generate' | 'r2_upload' | 'db_insert' = 'init';
    // Hoisted so the outer catch can refund on uncaught error.
    let chargeInfo: {
      ledgerId: string;
      action: import('../../../../lib/credits/pricing').CreditAction;
      totalCost: number;
      unitCredits: number;
    } | null = null;
    try {
      const openai = getOpenAI();
      if (!openai) return jsonError('ai_not_configured', 503);
      if (isStubMode.r2()) {
        return jsonError('r2_not_configured', 503, {
          hint: 'Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, NEXT_PUBLIC_R2_PUBLIC_URL_BASE.',
        });
      }
      const rl = rateLimit('agentRun', `imggen:${user.id}`);
      if (!rl.ok) {
        return new Response(JSON.stringify({ error: 'rate_limited', retryAfterSec: rl.retryAfterSec }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': String(rl.retryAfterSec) },
        });
      }
      const raw = await req.json().catch(() => ({}));
      const parsed = parseBody(bodySchema, raw);
      if (!parsed.ok) return parsed.response;
      const { prompt, size, quality, count, caption, rawPrompt } = parsed.data;

      // Credit pre-flight. We reserve the FULL cost upfront, then refund
      // any unfulfilled image after generation. This prevents a user from
      // racing two large requests that together exceed balance.
      const unit = priceForImage(size, quality);
      const totalCost = unit.credits * count;
      const pre = await ensureBalance(user.id, totalCost);
      if (!pre.ok) {
        console.log('[generate-image] insufficient credits:', pre);
        return insufficientCreditsResponse({ balance: pre.balance, needed: pre.needed });
      }
      // Charge upfront with the per-image action key. We hold the ledgerId
      // so we can issue a refund if generation fails partially or fully.
      const charged = await charge({
        userId: user.id,
        action: unit.action,
        credits: totalCost,
        meta: { size, quality, count, prompt: prompt.slice(0, 200) },
      });
      chargeInfo = { ledgerId: charged.ledgerId, action: unit.action, totalCost, unitCredits: unit.credits };
      console.log(`[generate-image] charged ${totalCost} credits (${unit.action} ×${count}), balance=${charged.balanceAfter}`);

      // Step tracking — lets the outer catch report WHICH hop blew up.
      step = 'rewrite';

      // 1. Rewrite prompt (unless the caller opted out). Inject the
      //    user's brand context so the rewriter knows WHO this is for
      //    — without it, output is generic stock-photo-feeling.
      console.log('[generate-image] step=rewrite');
      const brandCtx = await loadBrandContext(user.id);
      const brandBlock = renderBrandBlock(brandCtx, 'media');
      const rewrite = rawPrompt
        ? { prompt, enhanced: false }
        : await rewritePromptForMedia({ userPrompt: prompt, target: 'gpt-image-1', caption, brandBlock });
      console.log('[generate-image] step=rewrite done, enhanced=', rewrite.enhanced, 'brand=', !!brandBlock);

      const [w, h] = size.split('x').map((n) => parseInt(n, 10));

      // 2. Generate N in parallel. Each gpt-image-1 call returns one image.
      //    Strategy per call: try the SDK once, fall back to direct
      //    node:https.request on any TLS / network error.
      const apiKey = process.env.OPENAI_API_KEY ?? '';
      const generateOnce = async () => {
        try {
          // maxRetries: 0 — the SDK's default of 2 retries on a network
          // error means a TLS-broken machine sits there for ~50s before
          // our fallback kicks in. Fail fast, hand off to direct.
          return await openai.images.generate(
            {
              model: MODELS.image,
              prompt: rewrite.prompt,
              size,
              quality,
              n: 1,
            },
            { maxRetries: 0 },
          );
        } catch (e) {
          if (!isNetworkErr(e)) throw e;
          console.warn('[generate-image] SDK failed with network error, falling back to direct https.request:', flattenErr(e).slice(0, 200));
          return await generateImageDirect({ prompt: rewrite.prompt, size, quality, apiKey });
        }
      };

      step = 'generate';
      console.log('[generate-image] step=generate, count=', count);
      const generations = await Promise.allSettled(
        Array.from({ length: count }, () => generateOnce()),
      );
      const okCount = generations.filter((g) => g.status === 'fulfilled').length;
      console.log('[generate-image] step=generate done, fulfilled=', okCount, '/', generations.length);

      const firstReject = generations.find((g): g is PromiseRejectedResult => g.status === 'rejected');
      const networkFailureCount = generations.filter((g) => {
        if (g.status !== 'rejected') return false;
        return isNetworkErr((g as PromiseRejectedResult).reason);
      }).length;
      if (networkFailureCount > 0 && networkFailureCount === generations.length) {
        const flat = flattenErr(firstReject?.reason);
        console.error('[generate-image] all generations failed with network error:', flat.slice(0, 500));
        // Full refund — every image failed.
        if (chargeInfo) {
          await refund({ userId: user.id, ledgerId: chargeInfo.ledgerId, reason: 'upstream_network_error' });
          chargeInfo = null;
        }
        return jsonError('upstream_network_error', 502, {
          hint: 'Your machine couldn\'t complete a TLS handshake with the image provider — even after the HTTP/1.1 fallback. Most likely an antivirus is doing HTTPS inspection (Kaspersky, Bitdefender, ESET) or a corporate proxy is intercepting the connection. Disable HTTPS scanning for localhost or switch networks.',
          detail: flat.slice(0, 400),
        });
      }

      const rows: unknown[] = [];
      for (const g of generations) {
        if (g.status !== 'fulfilled') continue;
        const b64 = g.value.data?.[0]?.b64_json;
        if (!b64) continue;
        const buf = Buffer.from(b64, 'base64');
        const key = makeMediaKey(user.id, `gen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
        step = 'r2_upload';
        console.log('[generate-image] step=r2_upload, key=', key, 'bytes=', buf.length);
        await uploadBuffer({ key, body: buf, contentType: 'image/png' });
        console.log('[generate-image] step=r2_upload done');
        const url = publicUrlFor(key);
        step = 'db_insert';
        console.log('[generate-image] step=db_insert');
        const [row] = await db()
          .insert(mediaAssets)
          .values({
            userId: user.id,
            storageKey: key,
            publicUrl: url,
            mimeType: 'image/png',
            sizeBytes: buf.length,
            width: w,
            height: h,
            label: prompt.slice(0, 80),
          })
          .returning();
        console.log('[generate-image] step=db_insert done');
        rows.push(row);
      }

      if (rows.length === 0) {
        const reason = firstReject?.reason as { message?: string; status?: number } | null;
        console.error('[generate-image] no image returned. first reject:', reason?.message);
        if (chargeInfo) {
          await refund({ userId: user.id, ledgerId: chargeInfo.ledgerId, reason: 'no_image_returned' });
          chargeInfo = null;
        }
        return jsonError('no_image_returned', 502, { detail: (reason?.message ?? '').slice(0, 400) });
      }

      // Partial refund: user paid for `count` images but only `rows.length`
      // came back. Refund the cost of the missing ones.
      let creditsCharged = chargeInfo?.totalCost ?? 0;
      let balanceAfter: number | undefined;
      if (chargeInfo && rows.length < count) {
        const missing = count - rows.length;
        const refundCredits = chargeInfo.unitCredits * missing;
        const r = await partialRefund({
          userId: user.id,
          ledgerId: chargeInfo.ledgerId,
          credits: refundCredits,
          action: chargeInfo.action,
          reason: `partial_failure: ${rows.length}/${count} succeeded`,
        });
        creditsCharged = chargeInfo.totalCost - refundCredits;
        balanceAfter = r.balanceAfter;
        console.log(`[generate-image] partial refund: ${refundCredits} credits returned, ${rows.length}/${count} succeeded`);
      }

      return {
        items: rows,
        rewrittenPrompt: rewrite.prompt,
        enhanced: rewrite.enhanced,
        creditsCharged,
        balanceAfter,
      };
    } catch (e) {
      // Defensive: ANYTHING that escapes the inner try (rewriter, R2 upload,
      // db insert, etc.) lands here. If it looks network-shaped we return the
      // friendly 502 so the user sees the hint, not a withUser 500.
      const flat = flattenErr(e);
      const where = step;
      // Always refund on uncaught error — user shouldn't pay for a failure.
      if (chargeInfo) {
        try {
          await refund({ userId: user.id, ledgerId: chargeInfo.ledgerId, reason: `outer_catch:${where}` });
        } catch (refundErr) {
          console.warn('[generate-image] refund failed in outer catch:', refundErr);
        }
        chargeInfo = null;
      }
      if (isNetworkErr(e)) {
        console.error(`[generate-image] outer catch network error (step=${where}):`, flat.slice(0, 500));
        return jsonError('upstream_network_error', 502, {
          hint: `A TLS / network connection failed during step "${where}". Most likely an antivirus is doing HTTPS inspection (Kaspersky, Bitdefender, ESET) or a corporate proxy is intercepting the connection. Disable HTTPS scanning for localhost or switch networks.`,
          detail: flat.slice(0, 400),
          step: where,
        });
      }
      console.error(`[generate-image] outer catch unhandled error (step=${where}):`, flat.slice(0, 500));
      throw e; // let withUser see non-network errors
    }
  }, req);
}
