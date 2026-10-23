import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { getTextAI } from '../../../../lib/ai/client';
import { extractProducts, readSite, SITE_MODES } from '../../../../lib/ai/site-products';
import { priceForCompose } from '../../../../lib/credits/pricing';
import { charge, refund, InsufficientCreditsError, insufficientCreditsResponse } from '../../../../lib/credits/ledger';

export const runtime = 'nodejs';
// Two fetch rounds (10 s each at worst) + one LLM call (45 s cap).
export const maxDuration = 90;

const bodySchema = z.object({
  url: z.string().trim().min(3).max(2_000),
  /** products = one video per product; site = one video about the whole site; content = one per section/article/feature. */
  mode: z.enum(SITE_MODES as [string, ...string[]]).default('products'),
});

/** A bare "shop.com" means https. */
const normalize = (raw: string) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);

/**
 * POST /api/media/from-url { url } → 200 { site: { name, summary }, products: [{ id, name, pitch, facts, imageUrls, postText }], creditsCharged }
 *
 * Reads a product/company website (homepage + a few product pages, through the
 * SSRF-guarded fetchPage) and splits it into separate products, each with a
 * ready caption. Priced like Compose's "Write it for me" (text_post). The site
 * is fetched before anything is charged; the charge is refunded if the model
 * gives nothing usable.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const rl = rateLimit('videoPlan', `fromurl:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });
    const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;

    const ai = getTextAI('fast');
    if (!ai) return jsonError('ai_unavailable', 503, { hint: 'Reading websites is unavailable right now. Nothing was charged.' });

    const mode = parsed.data.mode as (typeof SITE_MODES)[number];
    const site = await readSite(normalize(parsed.data.url), mode);
    if ('error' in site) {
      if (site.error === 'invalid_url' || site.error === 'only_http' || site.error === 'url_required') {
        return jsonError('invalid_url', 400, { hint: 'Paste a full website address, like https://yourshop.com.' });
      }
      if (site.error === 'private_host_blocked') {
        return jsonError('url_not_allowed', 400, { hint: 'That address is not a public website, so we can’t read it.' });
      }
      return jsonError('site_unreachable', 502, { hint: 'We couldn’t open that site. Check the address, or try its product page directly. Nothing was charged.' });
    }
    if (site.text.trim().length < 40) {
      return jsonError('site_empty', 422, { hint: 'That page has almost no readable text (it may load everything with JavaScript). Try a specific product page. Nothing was charged.' });
    }

    const price = priceForCompose({ withTools: false });
    let charged;
    try {
      charged = await charge({ userId: user.id, action: price.action, credits: price.credits, meta: { via: 'from_url', mode, url: site.url.slice(0, 300) } });
    } catch (e) {
      if (e instanceof InsufficientCreditsError) return insufficientCreditsResponse({ balance: e.balance, needed: e.needed });
      throw e;
    }

    let result;
    try {
      result = await extractProducts(ai, site, mode);
    } catch (e) {
      console.error('[from-url] extract failed:', e instanceof Error ? e.message.slice(0, 300) : e);
      result = null;
    }
    if (!result) {
      await refund({ userId: user.id, ledgerId: charged.ledgerId, reason: 'from_url_extract_failed' }).catch(() => {});
      return jsonError('no_products_found', 502, { hint: 'We couldn’t make out what to make videos about on that site. Credits were refunded. Try another page or option.' });
    }
    return { ...result, creditsCharged: price.credits };
  }, req);
}
