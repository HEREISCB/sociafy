import { describe, it, expect } from 'vitest';
import { normalizeRazorpayStatus } from './status';

describe('normalizeRazorpayStatus', () => {
  it('maps active -> active', () => {
    expect(normalizeRazorpayStatus('active')).toBe('active');
  });

  it('maps halt/pause states to past_due', () => {
    expect(normalizeRazorpayStatus('halted')).toBe('past_due');
    expect(normalizeRazorpayStatus('paused')).toBe('past_due');
    expect(normalizeRazorpayStatus('pending')).toBe('past_due');
  });

  it('maps cancelled/completed/expired -> canceled', () => {
    expect(normalizeRazorpayStatus('cancelled')).toBe('canceled');
    expect(normalizeRazorpayStatus('completed')).toBe('canceled');
    expect(normalizeRazorpayStatus('expired')).toBe('canceled');
  });

  it('maps created/authenticated -> incomplete', () => {
    expect(normalizeRazorpayStatus('created')).toBe('incomplete');
    expect(normalizeRazorpayStatus('authenticated')).toBe('incomplete');
  });

  it('defaults unknown states to incomplete', () => {
    expect(normalizeRazorpayStatus('some_new_state' as never)).toBe('incomplete');
  });
});
