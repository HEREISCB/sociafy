import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: () => ({}) }));
vi.mock('../storage/r2', () => ({ publicUrlFor: (k: string) => k }));

import { cleanSegments } from './motionVersions';

describe('cleanSegments', () => {
  it('keeps well-formed segments, clamps to the video, drops the rest', () => {
    const out = cleanSegments([
      { id: 'a', label: 'Hook', startSec: 0, endSec: 4, onScreenText: 'Hi', suggestions: ['Bigger', 3] },
      { id: 'b', startSec: 4, endSec: 99 },
      { id: 'c', startSec: 5, endSec: 5 },
      { label: 'no id' },
      null,
    ], 15);
    expect(out).toEqual([
      { id: 'a', label: 'Hook', startSec: 0, endSec: 4, onScreenText: 'Hi', suggestions: ['Bigger'] },
      { id: 'b', label: 'Segment', startSec: 4, endSec: 15, onScreenText: '', suggestions: [] },
    ]);
    expect(cleanSegments('nope', 15)).toEqual([]);
  });
});
