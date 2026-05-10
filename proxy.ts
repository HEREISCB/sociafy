import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isProtected = createRouteMatcher(['/dashboard(.*)', '/onboarding(.*)']);
const isCron = createRouteMatcher(['/api/cron/(.*)']);

export default clerkMiddleware(async (auth, req) => {
  if (isCron(req)) return; // cron uses its own bearer-secret check
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
