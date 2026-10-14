import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { db } from '../../../lib/db';
import { agentSettings, profiles } from '../../../lib/db/schema';
import OnboardingClient from './client';

/**
 * Server-side guard: if the user has already finished onboarding, send
 * them to the dashboard instead of re-running the three-step setup.
 * Override with `?force=1` for testing.
 *
 * "Finished" has to mean the setup is usable, not just that it was touched.
 * profiles.onboardedAt is stamped by the FIRST settings PATCH — which happens
 * at the Topics step — so a user who bailed halfway (or clicked through the niche
 * step without picking one) got bounced straight back to the dashboard, where
 * every "Finish setup →" link led here and immediately redirected away again.
 * No niches, no way to pick any. onboardedAt is now only stamped by the
 * final step's PATCH (enabled: true), and an OAuth round-trip back here
 * (?connected= / ?oauth_error=) always lands on the page, never the redirect.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ force?: string; connected?: string; oauth_error?: string }>;
}) {
  const { userId } = await auth();
  if (userId) {
    const params = await searchParams;
    if (!params.force && !params.connected && !params.oauth_error) {
      const [profile] = await db()
        .select({ onboardedAt: profiles.onboardedAt, niches: agentSettings.niches })
        .from(profiles)
        .leftJoin(agentSettings, eq(agentSettings.userId, profiles.id))
        .where(eq(profiles.id, userId))
        .limit(1);
      if (profile?.onboardedAt && (profile.niches?.length ?? 0) > 0) {
        redirect('/dashboard');
      }
    }
  }
  return <OnboardingClient />;
}
