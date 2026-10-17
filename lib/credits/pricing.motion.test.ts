import { describe, it, expect } from 'vitest';
import { ACTION_LABELS, priceForMotion, priceForMotionAi, priceForMotionAiEdit } from './pricing';
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

describe('AI-designed motion-graphics pricing', () => {
  it('is 2 cr per second, length clamped to 6–20s', () => {
    expect(priceForMotionAi(6)).toEqual({ action: 'video_motion_ai', credits: 12 });
    expect(priceForMotionAi(15).credits).toBe(30);
    expect(priceForMotionAi(20).credits).toBe(40);
    expect(priceForMotionAi(2).credits).toBe(12);
    expect(priceForMotionAi(60).credits).toBe(40);
    expect(ACTION_LABELS.video_motion_ai).toBeTruthy();
  });

  it('adds 1 cr/s for a voiceover or music (once for both); sound effects are free', () => {
    const off = { narration: false, sfx: false, music: false };
    expect(priceForMotionAi(15, off).credits).toBe(30);
    expect(priceForMotionAi(15, { ...off, sfx: true }).credits).toBe(30);
    expect(priceForMotionAi(15, { ...off, narration: true })).toEqual({ action: 'video_motion_ai', credits: 45 });
    expect(priceForMotionAi(15, { ...off, music: true }).credits).toBe(45);
    expect(priceForMotionAi(15, { narration: true, sfx: true, music: true }).credits).toBe(45);
    expect(priceForMotionAi(6, { ...off, narration: true }).credits).toBe(18);
    expect(priceForMotionAi(60, { ...off, music: true }).credits).toBe(60);
  });
});

describe('AI-designed motion-graphic edit pricing', () => {
  it('is 1 cr per second of the video being edited', () => {
    expect(priceForMotionAiEdit(6)).toEqual({ action: 'video_motion_ai_edit', credits: 6 });
    expect(priceForMotionAiEdit(15).credits).toBe(15);
    expect(priceForMotionAiEdit(20).credits).toBe(20);
    expect(ACTION_LABELS.video_motion_ai_edit).toBeTruthy();
  });
});
