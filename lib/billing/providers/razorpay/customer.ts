import { eq } from 'drizzle-orm';
import { currentUser } from '@clerk/nextjs/server';
import { db } from '../../../db';
import { profiles } from '../../../db/schema';
import { getRazorpay } from './client';

/**
 * Returns the Razorpay customer id for a user, creating one on first
 * subscription if needed. Persists the id on `profiles.razorpay_customer_id`.
 */
export async function ensureRazorpayCustomer(userId: string): Promise<string> {
  const [row] = await db()
    .select({
      id: profiles.id,
      razorpayCustomerId: profiles.razorpayCustomerId,
      email: profiles.email,
      displayName: profiles.displayName,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  if (row?.razorpayCustomerId) return row.razorpayCustomerId;

  let email = row?.email ?? undefined;
  let name = row?.displayName ?? undefined;
  try {
    const u = await currentUser();
    email = u?.emailAddresses?.[0]?.emailAddress ?? email;
    const full = [u?.firstName, u?.lastName].filter(Boolean).join(' ');
    name = full || u?.username || name;
  } catch { /* okay */ }

  const customer = await getRazorpay().customers.create({
    email,
    name,
    notes: { sociafy_user_id: userId },
    fail_existing: 0,
  } as Parameters<ReturnType<typeof getRazorpay>['customers']['create']>[0]);

  await db()
    .update(profiles)
    .set({ razorpayCustomerId: customer.id, updatedAt: new Date() })
    .where(eq(profiles.id, userId));

  return customer.id;
}
