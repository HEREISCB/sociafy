import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { db } from '../../lib/db';
import { profiles } from '../../lib/db/schema';
import OnboardingClient from './client';

/**
 * Server-side guard: if the user has already finished onboarding, send
 * them to the dashboard instead of re-running the four-step setup.
 * Override with `?force=1` for testing.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ force?: string }>;
}) {
  const { userId } = await auth();
  if (userId) {
    const params = await searchParams;
    if (!params.force) {
      const [profile] = await db()
        .select({ onboardedAt: profiles.onboardedAt })
        .from(profiles)
        .where(eq(profiles.id, userId))
        .limit(1);
      if (profile?.onboardedAt) {
        redirect('/dashboard');
      }
    }
  }
  return <OnboardingClient />;
}
