import { describe, it, expect } from 'vitest';
import { ACTION_LABELS, MOTION_PER_SEC, priceForMotion, priceForMotionAi, priceForMotionAiEdit } from './pricing';
import { MOTION_TEMPLATES } from '../ai/models';

describe('motion-graphics pricing', () => {
  it('tracks Seedance 2.0 Fast 720p: $0.16/s × 112.5 = 18 cr/s', () => {
    expect(MOTION_PER_SEC).toBe(18);
  });

  it('is 18 cr per second of the template: sting 126, stat 270, showcase 288', () => {
    expect(priceForMotion(MOTION_TEMPLATES.sting.durationSec)).toEqual({ action: 'video_motion_graphics', credits: 126 });
    expect(priceForMotion(MOTION_TEMPLATES.stat.durationSec).credits).toBe(270);
    expect(priceForMotion(MOTION_TEMPLATES.showcase.durationSec).credits).toBe(288);
    expect(priceForMotion(7.2).credits).toBe(144); // rounded up per started second
    expect(priceForMotion(0).credits).toBe(18);
    expect(ACTION_LABELS.video_motion_graphics).toBeTruthy();
  });
});

describe('AI-designed motion-graphics pricing', () => {
  it('is 18 cr per second, length clamped to 6–60s', () => {
    expect(priceForMotionAi(6)).toEqual({ action: 'video_motion_ai', credits: 108 });
    expect(priceForMotionAi(15).credits).toBe(270);
    expect(priceForMotionAi(20).credits).toBe(360);
    expect(priceForMotionAi(2).credits).toBe(108);
    expect(priceForMotionAi(60).credits).toBe(1080);
    expect(priceForMotionAi(90).credits).toBe(1080);
    expect(ACTION_LABELS.video_motion_ai).toBeTruthy();
  });

  it('adds 4 cr/s for a voiceover or music (once for both); sound effects are free', () => {
    const off = { narration: false, sfx: false, music: false };
    expect(priceForMotionAi(15, off).credits).toBe(270);
    expect(priceForMotionAi(15, { ...off, sfx: true }).credits).toBe(270);
    expect(priceForMotionAi(15, { ...off, narration: true })).toEqual({ action: 'video_motion_ai', credits: 330 });
    expect(priceForMotionAi(15, { ...off, music: true }).credits).toBe(330);
    expect(priceForMotionAi(15, { narration: true, sfx: true, music: true }).credits).toBe(330);
    expect(priceForMotionAi(6, { ...off, narration: true }).credits).toBe(132);
    expect(priceForMotionAi(60, { ...off, music: true }).credits).toBe(1320);
  });
});

describe('AI-designed motion-graphic edit pricing', () => {
  it('is 9 cr per second of the video being edited (half the from-scratch rate)', () => {
    expect(priceForMotionAiEdit(6)).toEqual({ action: 'video_motion_ai_edit', credits: 54 });
    expect(priceForMotionAiEdit(15).credits).toBe(135);
    expect(priceForMotionAiEdit(20).credits).toBe(180);
    expect(priceForMotionAiEdit(60).credits).toBe(540);
    expect(ACTION_LABELS.video_motion_ai_edit).toBeTruthy();
  });
});
