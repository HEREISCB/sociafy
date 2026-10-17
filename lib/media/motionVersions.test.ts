import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: () => ({}) }));
vi.mock('../storage/r2', () => ({ publicUrlFor: (k: string) => k }));

import { cleanAudio, cleanSegments, readStored } from './motionVersions';

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

  it('keeps a segment narration line when there is one', () => {
    const out = cleanSegments([
      { id: 'a', startSec: 0, endSec: 4, narration: 'Hindi support is live.' },
      { id: 'b', startSec: 4, endSec: 8, narration: '  ' },
    ], 15);
    expect(out[0].narration).toBe('Hindi support is live.');
    expect(out[1]).not.toHaveProperty('narration');
  });
});

describe('cleanAudio / readStored', () => {
  it('keeps only real flags and known warnings; nothing reported = null', () => {
    expect(cleanAudio({ narration: true, sfx: 'yes', music: false, warning: 'audio_partial' })).toEqual({ narration: true, sfx: false, music: false, warning: 'audio_partial' });
    expect(cleanAudio({ narration: false, sfx: false, music: false, warning: 'audio_unavailable' })).toEqual({ narration: false, sfx: false, music: false, warning: 'audio_unavailable' });
    expect(cleanAudio({ narration: false, sfx: true, music: false, warning: 'boom' })).toEqual({ narration: false, sfx: true, music: false });
    expect(cleanAudio({ narration: false, sfx: false, music: false })).toBeNull();
    expect(cleanAudio(undefined)).toBeNull();
  });

  it('reads both stored shapes: a bare segment array (older/silent) and { segments, audio }', () => {
    const seg = { id: 'a', label: 'Hook', startSec: 0, endSec: 4, onScreenText: '', suggestions: [] };
    expect(readStored([seg])).toEqual({ segments: [seg], audio: null });
    expect(readStored({ segments: [seg], audio: { narration: true, sfx: false, music: false, warning: 'audio_partial' } }))
      .toEqual({ segments: [seg], audio: { narration: true, sfx: false, music: false, warning: 'audio_partial' } });
    expect(readStored(null)).toEqual({ segments: [], audio: null });
  });
});
