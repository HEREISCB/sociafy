import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const isProtected = createRouteMatcher(['/dashboard(.*)', '/onboarding(.*)']);
const isCron = createRouteMatcher(['/api/cron/(.*)']);

export default clerkMiddleware(async (auth, req) => {
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

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
    '/(api|trpc)(.*)',
  ],
};
