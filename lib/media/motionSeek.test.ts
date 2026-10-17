import { describe, expect, it } from 'vitest';
import { segmentSeekSec } from './motionSeek';

describe('segmentSeekSec', () => {
  it('lands 40% into the segment, never on the empty opening frame', () => {
    expect(segmentSeekSec(0, 5)).toBeCloseTo(2);
    expect(segmentSeekSec(5, 10)).toBeCloseTo(7);
  });
  it('stays inside tiny or degenerate segments', () => {
    expect(segmentSeekSec(1, 1.02)).toBe(1);
    expect(segmentSeekSec(2, 2)).toBe(2);
  });
});
