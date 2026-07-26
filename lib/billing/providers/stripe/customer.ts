import { eq } from 'drizzle-orm';
import { currentUser } from '@clerk/nextjs/server';
import { db } from '../../../db';
import { profiles } from '../../../db/schema';
import { getStripe } from '../../../stripe';

/**
 * Returns the Stripe customer id for a user, creating one on first
 * checkout if needed. Persists the id on `profiles.stripe_customer_id`.
 *
 * Persisting matters beyond convenience: the webhook's `invoice.paid` and
 * `customer.subscription.*` handlers resolve userId by looking this column
 * up (`resolveUserIdByCustomer`), so a renewal is only attributable if the
 * customer was created here rather than inline by Checkout.
 */
export async function ensureStripeCustomer(userId: string): Promise<string> {
  const [row] = await db()
    .select({
      id: profiles.id,
      stripeCustomerId: profiles.stripeCustomerId,
      email: profiles.email,
      displayName: profiles.displayName,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  if (row?.stripeCustomerId) return row.stripeCustomerId;

  let email = row?.email ?? undefined;
  let name = row?.displayName ?? undefined;
  try {
    const u = await currentUser();
    email = u?.emailAddresses?.[0]?.emailAddress ?? email;
    const full = [u?.firstName, u?.lastName].filter(Boolean).join(' ');
    name = full || u?.username || name;
  } catch { /* okay */ }

  const customer = await getStripe().customers.create({
    email,
    name,
    // Second resolution path in the webhook when the profile row hasn't
    // been linked yet.
    metadata: { sociafy_user_id: userId },
  });

  await db()
    .update(profiles)
    .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
    .where(eq(profiles.id, userId));

  return customer.id;
}
