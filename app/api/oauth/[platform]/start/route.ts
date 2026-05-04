import { NextRequest, NextResponse } from 'next/server';
import { authedUser } from '../../../../../lib/api';
import { isStubMode } from '../../../../../lib/env';
import { PLATFORMS, type Platform } from '../../../../../lib/db/schema';
import { getAdapter } from '../../../../../lib/platforms/registry';
import { signState, makeCodeVerifier } from '../../../../../lib/oauth/state';

export async function GET(req: NextRequest, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    return NextResponse.json({ error: 'invalid_platform' }, { status: 400 });
  }
  if (isStubMode.supabase()) {
    return NextResponse.redirect(new URL('/sign-in', req.url));
  }
  const user = await authedUser();
  if (!user) {
    return NextResponse.redirect(new URL('/sign-in', req.url));
  }

  const adapter = getAdapter(platform as Platform);
  const next = req.nextUrl.searchParams.get('next') || '/onboarding';
  const codeVerifier = platform === 'x' ? makeCodeVerifier() : undefined;
  const state = signState({ uid: user.id, platform, next, cv: codeVerifier });
  const redirectUri = new URL(`/api/oauth/${platform}/callback`, req.url).toString();

  if (!adapter.isConfigured()) {
    // Stub mode: fast-path to callback with stub flag. Keeps onboarding interactive.
    const stubUrl = new URL(`/api/oauth/${platform}/callback`, req.url);
    stubUrl.searchParams.set('state', state);
    stubUrl.searchParams.set('stub', '1');
    return NextResponse.redirect(stubUrl);
  }

  const url = adapter.buildAuthorizeUrl({ redirectUri, state, codeVerifier });
  return NextResponse.redirect(url);
}
