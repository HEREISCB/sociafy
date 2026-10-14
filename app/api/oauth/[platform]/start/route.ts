import { NextRequest, NextResponse } from 'next/server';
import { authedUser } from '../../../../../lib/api';
import { PLATFORMS, type Platform } from '../../../../../lib/db/schema';
import { getAdapter } from '../../../../../lib/platforms/registry';
import { signState, makeCodeVerifier, makeNonce, OAUTH_COOKIE, OAUTH_COOKIE_OPTS } from '../../../../../lib/oauth/state';
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

  const next = safeNextPath(req.nextUrl.searchParams.get('next'), '/onboarding');
  const sep = next.includes('?') ? '&' : '?';

  // Per-user + per-IP rate limit: prevents an authed user from spinning up
  // unlimited OAuth-state tokens (state HMAC compute is cheap but still
  // worth guarding) and a single attacker IP hammering before auth completes.
  const rlUser = rateLimit('oauthStart', user.id);
  const rlIp = rateLimit('oauthStart', `ip:${requestIp(req.headers)}`);
  if (!rlUser.ok || !rlIp.ok) {
    // This is a top-level navigation, so a JSON 429 would render as a raw page.
    return NextResponse.redirect(
      absoluteUrl(req, `${next}${sep}oauth_error=rate_limited&platform=${platform}`),
    );
  }

  const adapter = getAdapter(platform as Platform);
  const codeVerifier = platform === 'x' ? makeCodeVerifier() : undefined;
  // The nonce binds this state to this browser; the callback requires the
  // matching cookie, so a state link can't be replayed in someone else's session.
  const nonce = makeNonce();
  const state = signState({ uid: user.id, platform, next, n: nonce });
  const withCookie = (res: NextResponse) => {
    res.cookies.set(OAUTH_COOKIE, codeVerifier ? `${nonce}.${codeVerifier}` : nonce, {
      ...OAUTH_COOKIE_OPTS,
      maxAge: 15 * 60, // matches verifyState expiry
    });
    return res;
  };
  const redirectUri = absoluteUrl(req, `/api/oauth/${platform}/callback`);

  if (!adapter.isConfigured()) {
    // Stub connect mints a fake connected account (handle "you-on-x", token
    // "stub") that publishes to nowhere. It's a local-dev affordance
    // only — same gate as SKIP_AUTH_DEV in lib/api.ts. In production an
    // unconfigured platform must say so instead of faking success.
    if (process.env.NODE_ENV !== 'development') {
      return NextResponse.redirect(
        absoluteUrl(req, `${next}${sep}oauth_error=platform_not_configured&platform=${platform}`),
      );
    }
    const stubUrl = new URL(absoluteUrl(req, `/api/oauth/${platform}/callback`));
    stubUrl.searchParams.set('state', state);
    stubUrl.searchParams.set('stub', '1');
    return withCookie(NextResponse.redirect(stubUrl));
  }

  const url = adapter.buildAuthorizeUrl({ redirectUri, state, codeVerifier });
  return withCookie(NextResponse.redirect(url));
}
