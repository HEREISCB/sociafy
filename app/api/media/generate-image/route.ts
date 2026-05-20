import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { db } from '../../../../lib/db';
import { mediaAssets } from '../../../../lib/db/schema';
import { getOpenAI, MODELS } from '../../../../lib/ai/client';
import { rewritePromptForMedia } from '../../../../lib/ai/prompt-rewriter';
import { makeMediaKey, publicUrlFor, uploadBuffer } from '../../../../lib/storage/r2';
import { isStubMode } from '../../../../lib/env';

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

    // 2. Generate N in parallel. Each gpt-image-1 call returns one image; running
    //    them in Promise.all is faster than `n: count` and lets one failure not
    //    sink the others.
    const generations = await Promise.allSettled(
      Array.from({ length: count }, () =>
        openai.images.generate({
          model: MODELS.image,
          prompt: rewrite.prompt,
          size,
          quality,
          n: 1,
        }),
      ),
    );

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

    if (rows.length === 0) return jsonError('no_image_returned', 502);

    return {
      items: rows,
      rewrittenPrompt: rewrite.prompt,
      enhanced: rewrite.enhanced,
    };
  }, req);
}
