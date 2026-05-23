/**
 * Razorpay subscription state vocabulary → the four-value vocabulary the
 * rest of the app understands. Unknown future states default to
 * 'incomplete' so the UI prompts the user to investigate rather than
 * silently treating an unknown state as healthy.
 */

export type RazorpaySubscriptionStatus =
  | 'created'
  | 'authenticated'
  | 'active'
  | 'pending'
  | 'halted'
  | 'paused'
  | 'cancelled'
  | 'completed'
  | 'expired';

export type NormalizedStatus = 'active' | 'past_due' | 'canceled' | 'incomplete';

export function normalizeRazorpayStatus(s: RazorpaySubscriptionStatus): NormalizedStatus {
  switch (s) {
    case 'active':                                    return 'active';
    case 'pending':
    case 'halted':
    case 'paused':                                    return 'past_due';
    case 'cancelled':
    case 'completed':
    case 'expired':                                   return 'canceled';
    case 'created':
    case 'authenticated':                             return 'incomplete';
    default:                                          return 'incomplete';
  }
}
