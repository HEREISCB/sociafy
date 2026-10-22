import { describe, it, expect } from 'vitest';
import { scheduledCancelAt } from './cancel';

const now = new Date('2026-10-22T10:00:00Z');
const end = new Date('2026-11-14T00:00:00Z');
const base = {
  subscriptionStatus: 'active',
  pendingTierChangeTo: null,
  pendingTierChangeAt: end,
  subscriptionCurrentPeriodEnd: end,
};

describe('scheduledCancelAt', () => {
  it('reads a cancel marker as "ends on period end"', () => {
    expect(scheduledCancelAt(base, now)).toEqual(end);
  });

  it('is null with no marker', () => {
    expect(scheduledCancelAt({ ...base, pendingTierChangeAt: null }, now)).toBeNull();
  });

  it('a pending downgrade is not a cancel', () => {
    expect(scheduledCancelAt({ ...base, pendingTierChangeTo: 'starter' }, now)).toBeNull();
  });

  it('webhook wins: once the subscription is no longer active there is nothing to schedule', () => {
    expect(scheduledCancelAt({ ...base, subscriptionStatus: 'canceled' }, now)).toBeNull();
    expect(scheduledCancelAt({ ...base, subscriptionStatus: 'past_due' }, now)).toBeNull();
  });

  it('webhook wins: a later period end means Razorpay renewed, so the marker is stale', () => {
    const renewed = new Date('2026-12-14T00:00:00Z');
    expect(scheduledCancelAt({ ...base, subscriptionCurrentPeriodEnd: renewed }, now)).toBeNull();
  });

  it('still reads as cancelling after the end date until the webhook lands', () => {
    expect(scheduledCancelAt(base, new Date('2026-11-15T00:00:00Z'))).toEqual(end);
  });

  it('with no period end on record, only a future marker counts', () => {
    const noEnd = { ...base, subscriptionCurrentPeriodEnd: null };
    expect(scheduledCancelAt(noEnd, now)).toEqual(end);
    expect(scheduledCancelAt(noEnd, new Date('2026-12-01T00:00:00Z'))).toBeNull();
  });
});
