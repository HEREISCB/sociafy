import { describe, expect, it } from 'vitest';
import { planKeys, shownPlan } from './planKey';

describe('smart video plan keys', () => {
  const p3 = planKeys('Launch day! ₹99 this week ', ['linkedin'], [], null);
  const p3alt = planKeys('Launch day! ₹99 this week', ['linkedin'], [], { format: 'ai_video' });
  const p5 = planKeys('Elon Musk tried our espresso machine', ['linkedin'], [], null);

  it('override changes the full key, not the post key; trim is ignored', () => {
    expect(p3alt.input).toBe(p3.input);
    expect(p3alt.full).not.toBe(p3.full);
    expect(planKeys('x', ['a'], [{ url: 'u' }], null).input).not.toBe(planKeys('x', ['a'], [], null).input);
  });

  it("never shows another post's plan (the v14 race), shows the same post's while re-planning", () => {
    const last5 = { key: p5.full, input: p5.input, res: 'post 5 plan' };
    expect(shownPlan(p3alt, null, last5)).toEqual({ res: null, current: false });
    const last3 = { key: p3.full, input: p3.input, res: 'post 3 plan' };
    expect(shownPlan(p3alt, null, last3)).toEqual({ res: 'post 3 plan', current: false });
    expect(shownPlan(p3, null, last3)).toEqual({ res: 'post 3 plan', current: true });
    expect(shownPlan(p3alt, 'cached alt', last5)).toEqual({ res: 'cached alt', current: true });
  });
});
