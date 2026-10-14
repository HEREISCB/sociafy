import { NextRequest, NextResponse } from 'next/server';
import { db } from '../../../../../lib/db';
import { connectedAccounts, activityLog, PLATFORMS, type Platform } from '../../../../../lib/db/schema';
import { getAdapter } from '../../../../../lib/platforms/registry';
import { stubProfile } from '../../../../../lib/platforms/stub';
import { verifyState, checkOAuthCookie, OAUTH_COOKIE, OAUTH_COOKIE_OPTS } from '../../../../../lib/oauth/state';
import { authedUser } from '../../../../../lib/api';
import { absoluteUrl } from '../../../../../lib/url';
import { safeNextPath } from '../../../../../lib/safe-next';
import { encryptToken } from '../../../../../lib/crypto/tokens';

// A bad state can't tell us where the user came from (its `next` is untrusted),
// so every state failure lands on the connections tab.
const STATE_FAIL = '/dashboard?tab=connections&oauth_error=oauth_state';

/** Provider `?error=` → our oauth_error code. Cancels collapse to access_denied. */
function providerError(raw: string): string {
  const code = raw.toLowerCase().replace(/[^a-z_]/g, '').slice(0, 40);
  if (!code || /denied|cancel/.test(code)) return 'access_denied';
  return code;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    return NextResponse.json({ error: 'invalid_platform' }, { status: 400 });
  }
  const url = req.nextUrl;
  const stateParam = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const isStub = url.searchParams.get('stub') === '1';

  // Every exit clears the binding cookie, which makes a state single-use.
  const redirect = (path: string) => {
    const res = NextResponse.redirect(absoluteUrl(req, path));
    res.cookies.set(OAUTH_COOKIE, '', { ...OAUTH_COOKIE_OPTS, maxAge: 0 });
    return res;
  };

  const state = stateParam ? verifyState(stateParam) : null;
  if (!state || state.platform !== platform) return redirect(STATE_FAIL);
  // The state must have been started in this browser (cookie nonce) by the
  // user who is signed in now — otherwise a victim opening an attacker's
  // callback link would attach the attacker's account (or vice versa).
  const binding = checkOAuthCookie(req.cookies.get(OAUTH_COOKIE)?.value, state.n);
  if (!binding) return redirect(STATE_FAIL);
  const user = await authedUser();
  if (!user || user.id !== state.uid) return redirect(STATE_FAIL);

  const adapter = getAdapter(platform as Platform);
  const redirectUri = absoluteUrl(req, `/api/oauth/${platform}/callback`);
  const back = safeNextPath(state.next, '/onboarding');
  const backSep = back.includes('?') ? '&' : '?';

  // The user cancelled (or the provider refused). Never a stub, even in dev.
  const providerErr = url.searchParams.get('error');
  if (providerErr) {
    return redirect(`${back}${backSep}oauth_error=${providerError(providerErr)}&platform=${platform}`);
  }

  // Fake connected accounts are development-only (see the matching gate in
  // start/route.ts). Anywhere else, a ?stub=1 hit, an unconfigured platform,
  // or a missing ?code is an error — never a green "Connected" flash.
  const stubAllowed = process.env.NODE_ENV === 'development';
  const wantsStub = isStub || !adapter.isConfigured() || !code;
  if (wantsStub && !stubAllowed) {
    const reason = !adapter.isConfigured() ? 'platform_not_configured' : 'oauth_incomplete';
    return redirect(`${back}${backSep}oauth_error=${reason}&platform=${platform}`);
  }

  let result;
  try {
    // `|| !code` is redundant with wantsStub but narrows code to string here.
    if (wantsStub || !code) {
      result = stubProfile(platform as Platform, state.uid);
    } else {
      result = await adapter.exchangeCode({ code, redirectUri, codeVerifier: binding.cv || undefined });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The redirect only carries the error code; keep the provider's body in logs.
    console.error(`[oauth:${platform}] exchange failed`, msg, (e as { detail?: unknown }).detail);
    return redirect(`${back}${backSep}oauth_error=${encodeURIComponent(msg)}&platform=${platform}`);
  }

  // Upsert on the (user_id, platform) unique index — one statement, no
  // select-then-insert race between two concurrent callbacks.
  const fields = {
    platformUserId: result.profile.platformUserId,
    handle: result.profile.handle ?? null,
    displayName: result.profile.displayName ?? null,
    avatarUrl: result.profile.avatarUrl ?? null,
    accessToken: encryptToken(result.tokens.accessToken),
    refreshToken: result.tokens.refreshToken ? encryptToken(result.tokens.refreshToken) : null,
    tokenExpiresAt: result.tokens.expiresAt ?? null,
    scope: result.tokens.scope ?? null,
    meta: (result.tokens.meta ?? {}) as Record<string, unknown>,
    isStub: wantsStub,
  };
  await db()
    .insert(connectedAccounts)
    .values({ userId: state.uid, platform: platform as Platform, ...fields })
    .onConflictDoUpdate({
      target: [connectedAccounts.userId, connectedAccounts.platform],
      set: {
        ...fields,
        // A successful reconnect clears the refresh failure. Without this the
        // red "Reconnect needed" banner survived reconnecting, forever.
        lastRefreshError: null,
        lastRefreshErrorAt: null,
        updatedAt: new Date(),
      },
    });

  await db().insert(activityLog).values({
    userId: state.uid,
    kind: 'platform_connected',
    title: `Connected ${platform}${result.profile.handle ? ` (@${result.profile.handle})` : ''}`,
    meta: { platform, handle: result.profile.handle, stub: wantsStub },
  });

  const handle = result.profile.handle ? encodeURIComponent(result.profile.handle) : '';
  return redirect(`${back}${backSep}connected=${platform}${handle ? `&handle=${handle}` : ''}`);
}
