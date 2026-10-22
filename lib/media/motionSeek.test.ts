import { describe, expect, it } from 'vitest';
import { posterSeekSec, segmentSeekSec } from './motionSeek';

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

describe('posterSeekSec', () => {
  it('short clips (motion graphics) seek to the end card, 0.8 s before the end', () => {
    expect(posterSeekSec(10)).toBeCloseTo(9.2);
    expect(posterSeekSec(20)).toBeCloseTo(19.2);
    expect(posterSeekSec(60)).toBeCloseTo(59.2);
    expect(posterSeekSec(0.5)).toBe(0);
  });
  it('long footage seeks to 1 s', () => {
    expect(posterSeekSec(180)).toBeCloseTo(179.2);
    expect(posterSeekSec(180.5)).toBe(1);
    expect(posterSeekSec(600)).toBe(1);
  });
  it('bad durations stay at the start', () => {
    expect(posterSeekSec(0)).toBe(0);
    expect(posterSeekSec(NaN)).toBe(0);
    expect(posterSeekSec(Infinity)).toBe(0);
  });
});
