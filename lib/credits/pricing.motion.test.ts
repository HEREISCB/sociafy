import { describe, it, expect } from 'vitest';
import { ACTION_LABELS, MOTION_PER_SEC, footageEditCap, footageEditRefund, priceForFootageEdit, priceForMotion, priceForMotionAi, priceForMotionAiEdit } from './pricing';
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
  it('is 18 cr per second, length clamped to 6–180s', () => {
    expect(priceForMotionAi(6)).toEqual({ action: 'video_motion_ai', credits: 108 });
    expect(priceForMotionAi(15).credits).toBe(270);
    expect(priceForMotionAi(20).credits).toBe(360);
    expect(priceForMotionAi(2).credits).toBe(108);
    expect(priceForMotionAi(60).credits).toBe(1080);
    expect(priceForMotionAi(90).credits).toBe(1620);
    expect(priceForMotionAi(180).credits).toBe(3240);
    expect(priceForMotionAi(240).credits).toBe(3240);
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
    expect(priceForMotionAiEdit(180).credits).toBe(1620);
    expect(ACTION_LABELS.video_motion_ai_edit).toBeTruthy();
  });
});

describe('Edit my video pricing', () => {
  it('is 18 cr per second of the cap, +4 cr/s with music; speech is free', () => {
    expect(priceForFootageEdit(60)).toEqual({ action: 'video_edit_footage', credits: 1080, perSec: 18, sec: 60 });
    expect(priceForFootageEdit(20, { music: true })).toMatchObject({ credits: 440, perSec: 22 });
    expect(priceForFootageEdit(2).credits).toBe(108); // the minimum length
    expect(ACTION_LABELS.video_edit_footage).toBeTruthy();
  });

  it('caps at the chosen length or Auto (60 s), never past the clips + 5 s', () => {
    expect(footageEditCap(null)).toBe(60);
    expect(footageEditCap(null, 14.2)).toBe(20);
    expect(footageEditCap(30, 600)).toBe(30);
    expect(footageEditCap(30, 3)).toBe(8);
    expect(footageEditCap(null, 0.5)).toBe(6);
  });

  it('refunds the seconds the finished video did not use, never more than was charged', () => {
    expect(footageEditRefund({ charged: 1080, capSec: 60, actualSec: 12.4 })).toBe(1080 - 13 * 18);
    expect(footageEditRefund({ charged: 440, capSec: 20, actualSec: 19.996 })).toBe(0);
    expect(footageEditRefund({ charged: 1080, capSec: 60, actualSec: 3 })).toBe(1080 - 6 * 18);
    expect(footageEditRefund({ charged: 1080, capSec: 60, actualSec: 75 })).toBe(0);
    expect(footageEditRefund({ charged: 0, capSec: 60, actualSec: 10 })).toBe(0);
    expect(footageEditRefund({ charged: 1080, capSec: 60, actualSec: NaN })).toBe(0);
  });
});
