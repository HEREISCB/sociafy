import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '../../../../../lib/db';
import { connectedAccounts, activityLog, PLATFORMS, type Platform } from '../../../../../lib/db/schema';
import { getAdapter } from '../../../../../lib/platforms/registry';
import { stubProfile } from '../../../../../lib/platforms/stub';
import { verifyState } from '../../../../../lib/oauth/state';
import { absoluteUrl } from '../../../../../lib/url';
import { safeNextPath } from '../../../../../lib/safe-next';
import { encryptToken } from '../../../../../lib/crypto/tokens';

export async function GET(req: NextRequest, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    return NextResponse.json({ error: 'invalid_platform' }, { status: 400 });
  }
  const url = req.nextUrl;
  const stateParam = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const isStub = url.searchParams.get('stub') === '1';

  if (!stateParam) return NextResponse.redirect(absoluteUrl(req, '/onboarding?error=oauth_state'));
  const state = verifyState(stateParam);
  if (!state || state.platform !== platform) {
    return NextResponse.redirect(absoluteUrl(req, '/onboarding?error=oauth_state'));
  }

  const adapter = getAdapter(platform as Platform);
  const redirectUri = absoluteUrl(req, `/api/oauth/${platform}/callback`);
  const back = safeNextPath(state.next, '/onboarding');
  const backSep = back.includes('?') ? '&' : '?';

  // Fake connected accounts are development-only (see the matching gate in
  // start/route.ts). Anywhere else, a ?stub=1 hit, an unconfigured platform,
  // or a missing ?code is an error — never a green "Connected" flash.
  const stubAllowed = process.env.NODE_ENV === 'development';
  const wantsStub = isStub || !adapter.isConfigured() || !code;
  if (wantsStub && !stubAllowed) {
    const reason = !adapter.isConfigured() ? 'platform_not_configured' : 'oauth_incomplete';
    return NextResponse.redirect(
      absoluteUrl(req, `${back}${backSep}oauth_error=${reason}&platform=${platform}`),
    );
  }

  let result;
  try {
    // `|| !code` is redundant with wantsStub but narrows code to string here.
    if (wantsStub || !code) {
      result = stubProfile(platform as Platform, state.uid);
    } else {
      result = await adapter.exchangeCode({ code, redirectUri, codeVerifier: state.cv });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.redirect(
      absoluteUrl(req, `${back}${backSep}oauth_error=${encodeURIComponent(msg)}&platform=${platform}`),
    );
  }

  // Upsert: if user already connected this platform, update tokens.
  const existing = await db()
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.userId, state.uid), eq(connectedAccounts.platform, platform as Platform)))
    .limit(1);

  if (existing.length > 0) {
    await db()
      .update(connectedAccounts)
      .set({
        platformUserId: result.profile.platformUserId,
        handle: result.profile.handle ?? null,
        displayName: result.profile.displayName ?? null,
        avatarUrl: result.profile.avatarUrl ?? null,
        accessToken: encryptToken(result.tokens.accessToken),
        refreshToken: result.tokens.refreshToken ? encryptToken(result.tokens.refreshToken) : null,
        tokenExpiresAt: result.tokens.expiresAt ?? null,
        scope: result.tokens.scope ?? null,
        meta: (result.tokens.meta ?? {}) as Record<string, unknown>,
        isStub: isStub || !adapter.isConfigured(),
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, existing[0].id));
  } else {
    await db().insert(connectedAccounts).values({
      userId: state.uid,
      platform: platform as Platform,
      platformUserId: result.profile.platformUserId,
      handle: result.profile.handle ?? null,
      displayName: result.profile.displayName ?? null,
      avatarUrl: result.profile.avatarUrl ?? null,
      accessToken: encryptToken(result.tokens.accessToken),
      refreshToken: result.tokens.refreshToken ? encryptToken(result.tokens.refreshToken) : null,
      tokenExpiresAt: result.tokens.expiresAt ?? null,
      scope: result.tokens.scope ?? null,
      meta: (result.tokens.meta ?? {}) as Record<string, unknown>,
      isStub: isStub || !adapter.isConfigured(),
    });
  }

  await db().insert(activityLog).values({
    userId: state.uid,
    kind: 'platform_connected',
    title: `Connected ${platform}${result.profile.handle ? ` (@${result.profile.handle})` : ''}`,
    meta: { platform, handle: result.profile.handle, stub: isStub || !adapter.isConfigured() },
  });

  const handle = result.profile.handle ? encodeURIComponent(result.profile.handle) : '';
  return NextResponse.redirect(
    absoluteUrl(req, `${back}${backSep}connected=${platform}${handle ? `&handle=${handle}` : ''}`),
  );
}
