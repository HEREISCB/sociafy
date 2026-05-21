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
import { makeMediaKey, publicUrlFor, uploadBuffer } from '../../../../lib/storage/r2';
import { isStubMode } from '../../../../lib/env';

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
        agent: new https.Agent({ keepAlive: false }),
        minVersion: 'TLSv1.2',
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
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
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

    // 1. Rewrite prompt (unless the caller opted out)
    const rewrite = rawPrompt
      ? { prompt, enhanced: false }
      : await rewritePromptForMedia({ userPrompt: prompt, target: 'gpt-image-1', caption });

    const [w, h] = size.split('x').map((n) => parseInt(n, 10));

    // 2. Generate N in parallel. Each gpt-image-1 call returns one image.
    //    Strategy per call:
    //      a) Try the SDK once.
    //      b) On any TLS / network error, retry once via a direct
    //         node:https.request (HTTP/1.1, no keep-alive, TLS 1.2+ floor).
    //         This sidesteps undici's HTTP/2 + connection pool which some
    //         Windows AV / proxy stacks reject mid-handshake.
    const apiKey = process.env.OPENAI_API_KEY ?? '';
    // OpenAI SDK wraps network failures as APIConnectionError with the real
    // EPROTO / ECONNRESET buried in `.cause` (sometimes nested several
    // levels). Walk the whole chain — top-level error, all cause links,
    // even AggregateError.errors[].
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
    const generateOnce = async () => {
      try {
        return await openai.images.generate({
          model: MODELS.image,
          prompt: rewrite.prompt,
          size,
          quality,
          n: 1,
        });
      } catch (e) {
        if (!isNetworkErr(e)) throw e;
        console.warn('[generate-image] SDK failed with network error, falling back to direct https.request:', flattenErr(e).slice(0, 200));
        return await generateImageDirect({ prompt: rewrite.prompt, size, quality, apiKey });
      }
    };

    const generations = await Promise.allSettled(
      Array.from({ length: count }, () => generateOnce()),
    );

    // Surface the most common network failure cleanly. If EVERY generation
    // died with a TLS / connection error we tell the user it's their network
    // and stop wasting their time on a generic 500.
    const firstReject = generations.find((g): g is PromiseRejectedResult => g.status === 'rejected');
    const networkFailureCount = generations.filter((g) => {
      if (g.status !== 'rejected') return false;
      return isNetworkErr((g as PromiseRejectedResult).reason);
    }).length;
    if (networkFailureCount > 0 && networkFailureCount === generations.length) {
      const flat = flattenErr(firstReject?.reason);
      console.error('[generate-image] all generations failed with network error:', flat.slice(0, 500));
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
      await uploadBuffer({ key, body: buf, contentType: 'image/png' });
      const url = publicUrlFor(key);
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
      rows.push(row);
    }

    if (rows.length === 0) {
      // No image came back. Surface whatever the model actually returned so
      // the client can see it instead of a generic 502.
      const reason = firstReject?.reason as { message?: string; status?: number } | null;
      console.error('[generate-image] no image returned. first reject:', reason?.message);
      return jsonError('no_image_returned', 502, { detail: (reason?.message ?? '').slice(0, 400) });
    }

    return {
      items: rows,
      rewrittenPrompt: rewrite.prompt,
      enhanced: rewrite.enhanced,
    };
  }, req);
}
