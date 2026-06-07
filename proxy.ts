import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import type { NextFetchEvent, NextRequest } from 'next/server';

const isProtected = createRouteMatcher(['/dashboard(.*)', '/onboarding(.*)']);
const isCron = createRouteMatcher(['/api/cron/(.*)']);

const clerk = clerkMiddleware(async (auth, req) => {
  if (isCron(req)) return; // cron uses its own bearer-secret check
  // Signed-in users shouldn't see the marketing landing — send them to the app.
  if (req.nextUrl.pathname === '/') {
    const { userId } = await auth();
    if (userId) {
      const url = req.nextUrl.clone();
      url.pathname = '/dashboard';
      return NextResponse.redirect(url);
    }
  }
  if (isProtected(req)) {
    await auth.protect();
  }
});

// Canonicalize to the apex host BEFORE Clerk runs. A Clerk production instance
// is bound to one domain (sociafy.app); requests on www.sociafy.app fail its
// handshake and 500. Redirecting www -> apex here (outside clerkMiddleware)
// means Clerk only ever sees the registered origin, and OAuth redirect_uri /
// cookies all share one host. 308 preserves method + body.
export default function middleware(req: NextRequest, event: NextFetchEvent) {
  const host = req.headers.get('host') || '';
  if (host.startsWith('www.')) {
    const url = req.nextUrl.clone();
    url.host = host.slice(4);
    url.port = '';
    url.protocol = 'https:';
    return NextResponse.redirect(url, 308);
  }
  return clerk(req, event);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
    '/(api|trpc)(.*)',
  ],
};
