/**
 * The model's JSON — and our own fallback copy — decide whether something gets
 * posted to a real account. `score` is what the auto-publish threshold reads,
 * so it is treated as untrusted input, and the canned placeholder draft must
 * never be able to clear a threshold (it used to ship with score 88, above
 * both the 80 and 85 settings the UI offers).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./client', () => ({
  getTextAI: () => null, // no provider configured -> stub path
  completeText: async () => '',
}));

import { coerceDrafts, draftFromTrends } from './agent';

const TRENDS = [{ id: 't1', niche: 'tech', title: 'A trend', summary: null, sourceUrl: null }];

describe('stub drafts', () => {
  it('cannot clear any auto-publish threshold', async () => {
    const out = await draftFromTrends({
      instructions: '', voiceTemplate: 'me', niches: [], platforms: ['x'],
      brandSafetyStrict: false, trends: TRENDS, count: 2,
    });
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(0);
  });
});

describe('coerceDrafts', () => {
  it('clamps a model-controlled score into 0-100', () => {
    const out = coerceDrafts({ drafts: [{ body: 'a', score: 9999 }, { body: 'b', score: -50 }] }, ['x']);
    expect(out.map((d) => d.score)).toEqual([100, 0]);
  });

  it('scores unparseable/missing scores 0 so they never auto-publish', () => {
    const out = coerceDrafts({ drafts: [{ body: 'a' }, { body: 'b', score: 'ninety' }, { body: 'c', score: null }] }, ['x']);
    expect(out.map((d) => d.score)).toEqual([0, 0, 0]);
  });

  it('drops junk instead of trusting the shape', () => {
    expect(coerceDrafts({ drafts: 'nope' }, ['x'])).toEqual([]);
    expect(coerceDrafts({}, ['x'])).toEqual([]);
    expect(coerceDrafts(null, ['x'])).toEqual([]);
    // no body = nothing to post
    expect(coerceDrafts({ drafts: [{ score: 95 }, { body: '   ', score: 95 }] }, ['x'])).toEqual([]);
  });

  it('keeps only per-platform text for the requested platforms, as strings', () => {
    const out = coerceDrafts(
      { drafts: [{ body: 'a', score: 90, perPlatform: { x: 'hi', linkedin: 'nope', tiktok: 42 } }] },
      ['x', 'tiktok'],
    );
    expect(out[0].perPlatform).toEqual({ x: 'hi' });
  });
});
