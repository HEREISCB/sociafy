import { NextRequest, NextResponse } from 'next/server';
import { authedUser } from '../../../../../lib/api';
import { PLATFORMS, type Platform } from '../../../../../lib/db/schema';
import { getAdapter } from '../../../../../lib/platforms/registry';
import { signState, makeCodeVerifier } from '../../../../../lib/oauth/state';
import { absoluteUrl } from '../../../../../lib/url';

export async function GET(req: NextRequest, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    return NextResponse.json({ error: 'invalid_platform' }, { status: 400 });
  }
  const user = await authedUser();
  if (!user) {
    return NextResponse.redirect(absoluteUrl(req, '/sign-in'));
  }

  const adapter = getAdapter(platform as Platform);
  const next = req.nextUrl.searchParams.get('next') || '/onboarding';
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
