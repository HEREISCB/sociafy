import { NextRequest } from 'next/server';
import { withUser } from '../../../../lib/api';
import { rateLimit } from '../../../../lib/rate-limit';
import { searchImages } from '../../../../lib/ai/skills/images';

/**
 * GET /api/media/search?q=...&limit=6
 * Image search proxy backed by Unsplash → Pexels → stub.
 * Keep keys server-side; the UI hits this endpoint instead of the providers.
 */
export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    const rl = rateLimit('general', `image-search:${user.id}`);
    if (!rl.ok) {
      return new Response(JSON.stringify({ error: 'rate_limited', retryAfterSec: rl.retryAfterSec }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': String(rl.retryAfterSec) },
      });
    }
    const q = (req.nextUrl.searchParams.get('q') ?? '').slice(0, 200).trim();
    if (!q) return Response.json({ error: 'query_required' }, { status: 400 });
    const limit = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('limit') ?? '6', 10), 1), 12);
    const results = await searchImages(q, limit);
    return Response.json({ query: q, count: results.length, results });
  }, req);
}
