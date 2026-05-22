import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { agentSettings } from '../../../../lib/db/schema';
import { generateCompose, type ComposePresetKey } from '../../../../lib/ai/compose';
import { loadBrandContext, renderBrandBlock } from '../../../../lib/ai/brand-context';
import { composeVariantsSchema, parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { priceForCompose, CREDIT_PRICES } from '../../../../lib/credits/pricing';
import { ensureBalance, charge, partialRefund, refund, insufficientCreditsResponse } from '../../../../lib/credits/ledger';

const PRESET_KEYS = ['thread', 'announcement', 'recap', 'hot-take', 'lesson', 'reel'] as const;

export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    // Compose hits Anthropic which costs money — rate limit per user.
    const rl = rateLimit('agentRun', `compose:${user.id}`);
    if (!rl.ok) {
      return new Response(
        JSON.stringify({ error: 'rate_limited', retryAfterSec: rl.retryAfterSec }),
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(rl.retryAfterSec) } },
      );
    }
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(composeVariantsSchema, raw);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const preset = (PRESET_KEYS as readonly string[]).includes(body.preset ?? '')
      ? (body.preset as ComposePresetKey)
      : undefined;

    const [settings] = await db()
      .select()
      .from(agentSettings)
      .where(eq(agentSettings.userId, user.id))
      .limit(1);

    // Brand context — company name, bio, website, niches. Goes into the
    // system prompt so the model knows WHO this user is, not just HOW
    // they sound. Without this the model can match voice but writes
    // generic posts about generic topics.
    const brandCtx = await loadBrandContext(user.id);
    const brandBlock = renderBrandBlock(brandCtx, 'text');

    // Credit pre-flight. Worst case for "with research" mode: agent uses
    // base + 3 extra searches = 6 + 15 = 21 credits. Reserve that, then
    // refund unused searches after the call returns.
    const withTools = body.withTools === true;
    const maxExtraSearches = withTools ? 3 : 0;
    const maxCost = priceForCompose({ withTools, extraSearches: maxExtraSearches }).credits;
    const pre = await ensureBalance(user.id, maxCost);
    if (!pre.ok) {
      return insufficientCreditsResponse({ balance: pre.balance, needed: pre.needed });
    }
    const reservedAction = withTools ? 'text_post_research' : 'text_post';
    const reserved = await charge({
      userId: user.id,
      action: reservedAction,
      credits: maxCost,
      meta: { withTools, reserved: true, prompt: body.prompt.slice(0, 200) },
    });

    let result;
    try {
      result = await generateCompose({
        prompt: body.prompt,
        platforms: body.platforms.length ? body.platforms : undefined,
        preset,
        voiceTemplate: body.voice ?? settings?.voiceTemplate ?? 'me',
        agentInstructions: settings?.instructions,
        brandBlock,
        count: body.count ?? 4,
        withTools,
        userId: user.id,
      });
    } catch (e) {
      // Failed to generate — refund everything we reserved.
      await refund({ userId: user.id, ledgerId: reserved.ledgerId, reason: 'compose_generation_failed' }).catch(() => {});
      throw e;
    }

    // Reconcile: count actual web_search invocations and partial-refund the
    // unused reservation. We bundle 1 free search into the research base, so
    // the surcharge only kicks in from the 2nd search onward.
    const searchCount = withTools
      ? (result.toolsUsed ?? []).filter((t) => t === 'web_search').length
      : 0;
    const extraSearches = Math.max(0, searchCount - 1);
    const actual = priceForCompose({ withTools, extraSearches }).credits;
    const refundCredits = Math.max(0, maxCost - actual);
    if (refundCredits > 0) {
      await partialRefund({
        userId: user.id,
        ledgerId: reserved.ledgerId,
        credits: refundCredits,
        action: reservedAction,
        reason: `reconcile: ${searchCount} search(es), ${actual} credits used`,
      });
    }

    return {
      ...result,
      creditsCharged: actual,
      meta: { searchCount, extraSearches, surcharge: extraSearches * CREDIT_PRICES.web_search_extra },
    };
  }, req);
}
