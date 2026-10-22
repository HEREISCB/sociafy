/**
 * Our record of a cycle-end cancel, without a migration.
 *
 * Razorpay's `cancel_at_cycle_end` leaves the subscription active until its
 * period ends, and nothing reached our DB until the end-of-cycle webhook — so
 * the page said "renews" and offered Cancel again. We now record the cancel in
 * the existing pending-change columns:
 *
 *   pendingTierChangeTo = null, pendingTierChangeAt = <period end>
 *
 * read as "cancels at". A pending downgrade sets both columns, so the two never
 * collide (and a downgrade IS a cycle-end cancel on Razorpay's side too).
 *
 * The webhook stays the source of truth: the marker only counts while the
 * subscription is still `active` and its period end has not moved past it. A
 * `subscription.cancelled` flips the status; a renewal pushes the period end
 * forward. Either way the stale marker is ignored, so nothing needs clearing.
 */
export function scheduledCancelAt(
  p: {
    subscriptionStatus: string | null;
    pendingTierChangeTo: string | null;
    pendingTierChangeAt: Date | null;
    subscriptionCurrentPeriodEnd: Date | null;
  },
  now: Date,
): Date | null {
  const at = p.pendingTierChangeAt;
  if (p.subscriptionStatus !== 'active' || p.pendingTierChangeTo || !at) return null;
  if (p.subscriptionCurrentPeriodEnd) {
    return p.subscriptionCurrentPeriodEnd.getTime() <= at.getTime() ? at : null;
  }
  // No period end on record (e.g. just after an upgrade): trust only a future marker.
  return at.getTime() > now.getTime() ? at : null;
}
