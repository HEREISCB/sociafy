import { describe, it, expect } from 'vitest';
import { priceForChat } from './pricing';

describe('priceForChat', () => {
  it('rounds provider cost up at 112.5 cr/$ with a 1-credit floor', () => {
    expect(priceForChat('smart', 0, 0).credits).toBe(1);
    expect(priceForChat('smart', 1500, 500).credits).toBe(1); // $0.006875 → 0.77
    expect(priceForChat('smart', 3000, 4000).credits).toBe(5); // $0.04375 → 4.92
    expect(priceForChat('smart', 0, 8192).credits).toBe(10); // $0.08192 → 9.22
    expect(priceForChat('fast', 3000, 4000).credits).toBe(1); // $0.00875 → 0.98
    expect(priceForChat('fast', 0, 8192).credits).toBe(2); // $0.016384 → 1.84
    expect(priceForChat('smart', 1, 1).action).toBe('text_chat');
  });
});
