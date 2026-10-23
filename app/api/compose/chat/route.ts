import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { completeText, getTextAI } from '../../../../lib/ai/client';
import { loadBrandContext, renderBrandBlock } from '../../../../lib/ai/brand-context';
import { PLATFORMS, type Platform } from '../../../../lib/db/schema';
import { MOTION_AI } from '../../../../lib/ai/models';
import { priceForCompose } from '../../../../lib/credits/pricing';
import { charge, ensureBalance, insufficientCreditsResponse, refund } from '../../../../lib/credits/ledger';

export const runtime = 'nodejs';
export const maxDuration = 60;

const bodySchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().trim().min(1).max(2_000),
  })).min(1).max(20).refine((m) => m.at(-1)?.role === 'user', 'last message must be from the user'),
  body: z.string().max(4_000).optional(),
  platforms: z.array(z.string().trim().max(20)).max(10).optional(),
});

/** What the model must answer. Lenient on nulls; normalized below. */
const replySchema = z.object({
  reply: z.string().trim().min(1).max(1_500),
  post: z.string().trim().max(4_000).nullish(),
  durationSec: z.number().nullish(),
  platforms: z.array(z.string()).nullish(),
});

const SYSTEM = `You help a small business owner brief a short social video and its post.
The post text you write is ALSO the brief our video engine turns into a video, so it must name the product/offer, the hook and the tone.
Rules:
- Ask at most ONE short follow-up, and only when you truly cannot write the post (you don't know what the product/offer is). Never ask more than twice in a conversation. Otherwise write the post right away and make sensible assumptions.
- When the user asks for changes ("punchier", "mention the price", "make it 20 seconds"), revise the current post.
- Write in the user's language. No hashtag walls (0-3 hashtags). No emojis unless the user uses them.
Answer ONLY with a JSON object:
{"reply": "1-2 short sentences to the user (or your one question)",
 "post": "the full post text" or null when you asked a question,
 "durationSec": a whole number ${MOTION_AI.durationSec.min}-${MOTION_AI.durationSec.max} only if the user asked for a length, else null,
 "platforms": array from [${PLATFORMS.join(', ')}] only if the user named platforms, else null}`;

/**
 * POST /api/compose/chat { messages, body?, platforms? }
 *   → { reply, post?, durationSec?, platforms?, ready }
 * Compose's chat: talk a video brief into the post box. Charged like "Write it
 * for me" (priceForCompose, no research) per message; refunded when the model
 * fails or answers garbage.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const rl = rateLimit('videoPlan', `composechat:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });
    const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;
    const { messages, body, platforms } = parsed.data;

    const ai = getTextAI('fast');
    if (!ai) return jsonError('ai_unavailable', 503, { hint: 'Chat isn’t available right now. Try again shortly.' });

    const price = priceForCompose({ withTools: false });
    const pre = await ensureBalance(user.id, price.credits);
    if (!pre.ok) return insufficientCreditsResponse({ balance: pre.balance, needed: pre.needed });
    const charged = await charge({ userId: user.id, action: price.action, credits: price.credits, meta: { chat: true } });

    const brand = renderBrandBlock(await loadBrandContext(user.id).catch(() => null), 'text');
    const prompt = [
      brand,
      body?.trim() ? `Current post:\n"""${body.trim()}"""` : 'The post box is empty.',
      platforms?.length ? `Posting to: ${platforms.join(', ')}` : '',
      'Conversation:',
      ...messages.map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content}`),
    ].filter(Boolean).join('\n\n');

    try {
      const raw = await completeText(ai, { system: SYSTEM, user: prompt, json: true, maxOutputTokens: 1_500, timeoutMs: 30_000 });
      const out = replySchema.parse(JSON.parse(raw));
      const post = out.post || undefined;
      const dur = out.durationSec != null && Number.isFinite(out.durationSec) ? Math.min(MOTION_AI.durationSec.max, Math.max(MOTION_AI.durationSec.min, Math.round(out.durationSec))) : undefined;
      const ps = (out.platforms ?? []).map((p) => p.toLowerCase().trim()).filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p));
      return {
        reply: out.reply,
        ...(post ? { post } : {}),
        ...(dur ? { durationSec: dur } : {}),
        ...(ps.length ? { platforms: [...new Set(ps)] } : {}),
        ready: Boolean(post),
        creditsCharged: price.credits,
      };
    } catch (e) {
      console.warn('[compose-chat] failed:', e instanceof Error ? e.message.slice(0, 200) : e);
      await refund({ userId: user.id, ledgerId: charged.ledgerId, reason: 'compose_chat_failed' }).catch(() => {});
      return jsonError('chat_failed', 502, { hint: 'Couldn’t get a reply. Nothing was charged, so try again.' });
    }
  }, req);
}
