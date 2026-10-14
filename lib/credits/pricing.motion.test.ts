import { describe, it, expect } from 'vitest';
import { ACTION_LABELS, priceForMotion } from './pricing';
import { MOTION_TEMPLATES } from '../ai/models';

describe('motion-graphics pricing', () => {
  it('is flat per started 8s: sting 5, stat/showcase 10', () => {
    expect(priceForMotion(MOTION_TEMPLATES.sting.durationSec)).toEqual({ action: 'video_motion_graphics', credits: 5 });
    expect(priceForMotion(MOTION_TEMPLATES.stat.durationSec).credits).toBe(10);
    expect(priceForMotion(MOTION_TEMPLATES.showcase.durationSec).credits).toBe(10);
    expect(priceForMotion(0).credits).toBe(5);
    expect(ACTION_LABELS.video_motion_graphics).toBeTruthy();
  });
});
