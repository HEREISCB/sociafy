import { describe, expect, it } from 'vitest';
import { showcaseState } from '../components/landing-islands';

describe('showcaseState (hero showcase clock)', () => {
  it('walks one example through its steps', () => {
    expect(showcaseState(0.1)).toMatchObject({ s: 0, typed: false, dev: false, fan: false, filed: 2 });
    expect(showcaseState(1.5)).toMatchObject({ s: 0, typed: true, dev: true, fan: false, filed: 2 });
    expect(showcaseState(5)).toMatchObject({ s: 0, typed: true, dev: true, fan: true, filed: 0 });
    expect(showcaseState(7.8)).toMatchObject({ s: 0, typed: false, dev: false, fan: false, filed: 0 });
  });
  it('keeps the last example filed until the next one files, across the loop', () => {
    expect(showcaseState(9)).toMatchObject({ s: 1, filed: 0 });
    expect(showcaseState(13)).toMatchObject({ s: 1, filed: 1 });
    expect(showcaseState(23.9)).toMatchObject({ s: 2, filed: 2 });
    expect(showcaseState(24.1)).toMatchObject({ s: 0, filed: 2 });
  });
});
