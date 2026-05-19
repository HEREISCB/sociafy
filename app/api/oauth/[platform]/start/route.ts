import { NextRequest, NextResponse } from 'next/server';
import { authedUser } from '../../../../../lib/api';
import { PLATFORMS, type Platform } from '../../../../../lib/db/schema';
import { getAdapter } from '../../../../../lib/platforms/registry';
import { signState, makeCodeVerifier } from '../../../../../lib/oauth/state';
import { absoluteUrl } from '../../../../../lib/url';
import { safeNextPath } from '../../../../../lib/safe-next';
import { rateLimit, requestIp } from '../../../../../lib/rate-limit';

export async function GET(req: NextRequest, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    return NextResponse.json({ error: 'invalid_platform' }, { status: 400 });
  }
  const user = await authedUser();
  if (!user) {
    return NextResponse.redirect(absoluteUrl(req, '/sign-in'));
  }

  // Per-user + per-IP rate limit: prevents an authed user from spinning up
  // unlimited OAuth-state tokens (state HMAC compute is cheap but still
  // worth guarding) and a single attacker IP hammering before auth completes.
  const rlUser = rateLimit('oauthStart', user.id);
  const rlIp = rateLimit('oauthStart', `ip:${requestIp(req.headers)}`);
  if (!rlUser.ok || !rlIp.ok) {
    const retry = Math.max(rlUser.retryAfterSec, rlIp.retryAfterSec);
    return new NextResponse(JSON.stringify({ error: 'rate_limited', retryAfterSec: retry }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(retry) },
    });
  }

  const adapter = getAdapter(platform as Platform);
  const next = safeNextPath(req.nextUrl.searchParams.get('next'), '/onboarding');
  const codeVerifier = platform === 'x' ? makeCodeVerifier() : undefined;
  const state = signState({ uid: user.id, platform, next, cv: codeVerifier });
  const redirectUri = absoluteUrl(req, `/api/oauth/${platform}/callback`);

  if (!adapter.isConfigured()) {
    const stubUrl = new URL(absoluteUrl(req, `/api/oauth/${platform}/callback`));
    stubUrl.searchParams.set('state', state);
    stubUrl.searchParams.set('stub', '1');
    return NextResponse.redirect(stubUrl);
  }

  const url = adapter.buildAuthorizeUrl({ redirectUri, state, codeVerifier });
  return NextResponse.redirect(url);
}
