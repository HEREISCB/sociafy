import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { jsonError } from '../../../lib/api';
import { parseBody } from '../../../lib/validation';
import { rateLimit } from '../../../lib/rate-limit';
import { verifyTurnstile } from '../../../lib/turnstile';
import { clientIp, hashIp } from '../../../lib/try';
import { getOpenAI, getTextAI, completeText } from '../../../lib/ai/client';
import { FREE_TONES, FREE_TOOL_IDS, FREE_TOOL_PROMPTS, parseResults } from '../../../lib/free-tools';

export const runtime = 'nodejs';
export const maxDuration = 60;

const body = z.object({
  tool: z.enum(FREE_TOOL_IDS),
  input: z.string().trim().min(3).max(1500),
  tone: z.enum(FREE_TONES).optional(),
  turnstileToken: z.string().max(4096).nullable().optional(),
});

/** Free moderation check. Fails open: an outage there shouldn't take the tools down. */
async function flagged(input: string): Promise<boolean> {
  try {
    const r = await getOpenAI()?.moderations.create({ model: 'omni-moderation-latest', input });
    return !!r?.results.some((x) => x.flagged);
  } catch {
    return false;
  }
}

/** POST /api/free-tools — public text generators, no account. Guarded by per-IP rate limit + Turnstile. */
export async function POST(req: NextRequest) {
  const parsed = parseBody(body, await req.json().catch(() => ({})));
  if (!parsed.ok) return parsed.response;
  const { tool, input, tone, turnstileToken } = parsed.data;

  const ip = clientIp(req.headers);
  // ponytail: in-memory per-instance limit; move to Redis/KV if we scale out or see abuse.
  const rl = rateLimit('freeText', hashIp(ip));
  if (!rl.ok) {
    return jsonError('rate_limited', 429, {
      hint: `You've hit the free limit for now. Try again in ${Math.ceil(rl.retryAfterSec / 60)} min, or sign up free to generate as much as you need.`,
    });
  }
  if (!(await verifyTurnstile(turnstileToken, ip))) {
    return jsonError('bot_check_failed', 403, { hint: 'Please complete the quick check below and try again.' });
  }
  if (await flagged(input)) {
    return jsonError('flagged', 422, { hint: 'That topic isn’t something we can write about. Try rephrasing it.' });
  }

  const ai = getTextAI('fast');
  if (!ai) return jsonError('ai_unavailable', 503, { hint: 'The generator is offline right now. Try again soon.' });

  const { system, maxOutputTokens } = FREE_TOOL_PROMPTS[tool];
  try {
    const raw = await completeText(ai, {
      system,
      user: `${tone ? `Tone: ${tone}.\n` : ''}Topic:\n"""${input}"""`,
      // gpt-5 spends part of max_output_tokens on reasoning before any text;
      // without headroom the JSON is cut off mid-string. Still well under a cent.
      maxOutputTokens: maxOutputTokens + 1500,
      json: true,
      timeoutMs: 30_000,
    });
    const results = parseResults(raw);
    if (!results.length) throw new Error('empty');
    return NextResponse.json({ results });
  } catch (e) {
    console.error('[free-tools]', tool, e instanceof Error ? e.message : e);
    return jsonError('generation_failed', 502, { hint: 'The writer is busy. Give it another go in a moment.' });
  }
}
