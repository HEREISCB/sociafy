import { describe, it, expect } from 'vitest';
import { nextPostingWindow } from './windows';

/**
 * Jitter used to be applied AFTER the quiet-hours check, which pushed the slot
 * up to 25 minutes past the boundary and landed inside quiet hours about half
 * the time. Jitter first, then validate.
 */
describe('nextPostingWindow', () => {
  it('never returns a time inside quiet hours', () => {
    const quiet = { start: '16:00', end: '10:00' }; // leaves 10:00-16:00 open
    for (let i = 0; i < 2000; i++) {
      const now = new Date(Date.UTC(2026, 0, 1, i % 24, (i * 7) % 60));
      const h = nextPostingWindow(now, quiet).getUTCHours();
      expect(h >= 10 && h < 16).toBe(true);
    }
  });
});

/**
 * The give-up path used to return the raw candidate with no quiet check at all,
 * so roughly 1 call in 3000 scheduled a post inside the hours the user had
 * explicitly blocked. Quiet hours are an instruction; business windows are a
 * preference. When they conflict, the instruction wins.
 */
describe('nextPostingWindow — no business window is reachable', () => {
  it('still refuses to schedule inside quiet hours', () => {
    // 08:00-19:00 quiet swallows all three business windows (9-11, 12-13, 16-18).
    const quiet = { start: '08:00', end: '19:00' };
    for (let i = 0; i < 500; i++) {
      const now = new Date(Date.UTC(2026, 0, 1, i % 24, (i * 7) % 60));
      const h = nextPostingWindow(now, quiet).getUTCHours();
      expect(h >= 19 || h < 8).toBe(true);
    }
  });
});
