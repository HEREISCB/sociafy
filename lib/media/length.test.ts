import { describe, it, expect } from 'vitest';
import { LENGTH_STOPS, fmtLength, lengthStop, spokenLength } from './length';

describe('video length slider', () => {
  it('steps 1 s to a minute, then 5 s to 3 minutes', () => {
    expect(LENGTH_STOPS[0]).toBe(6);
    expect(LENGTH_STOPS).toContain(59);
    expect(LENGTH_STOPS).not.toContain(61);
    expect(LENGTH_STOPS.slice(-3)).toEqual([170, 175, 180]);
    expect(LENGTH_STOPS.length).toBe(55 + 24);
  });
  it('maps lengths to positions (0 = AI decides), snapping off-stop lengths', () => {
    expect(lengthStop(null)).toBe(0);
    expect(LENGTH_STOPS[lengthStop(6) - 1]).toBe(6);
    expect(LENGTH_STOPS[lengthStop(180) - 1]).toBe(180);
    expect(LENGTH_STOPS[lengthStop(67) - 1]).toBe(65);
    expect(LENGTH_STOPS[lengthStop(68) - 1]).toBe(70);
  });
  it('reads m:ss past 59 s', () => {
    expect(fmtLength(45)).toBe('45s');
    expect(fmtLength(60)).toBe('1:00');
    expect(fmtLength(150)).toBe('2:30');
    expect(spokenLength(150)).toBe('2 min 30 s');
    expect(spokenLength(120)).toBe('2 min');
    expect(spokenLength(15)).toBe('15 seconds');
  });
});
