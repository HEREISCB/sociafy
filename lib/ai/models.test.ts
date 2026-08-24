import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VIDEO_MODEL,
  VIDEO_MODELS,
  VIDEO_MODEL_IDS,
  backendFor,
  isVideoModelId,
  modelForBackend,
  validateAgainstModel,
} from './models';
import { CREDITS_PER_PROVIDER_USD, creditsFromProviderUsd } from '../credits/pricing';
import { CINEMA_MAX_ATTACHMENT_B64, CinemaAttachmentTooLarge, encodeCinemaFrames } from './cue';

const base = {
  durationSec: 8,
  quality: '720p' as const,
  aspect: '9:16',
  genMode: 'text',
  fast: false,
};

describe('the white-label boundary', () => {
  it('names no vendor anywhere a customer can see', () => {
    // The whole point of lib/ai/models.ts. A vendor name in an id, a label or a
    // summary is a leak that integrators build against and we then cannot undo.
    const forbidden = /cue|velina|seedance|piapi|bytedance|h3\b/i;
    for (const id of VIDEO_MODEL_IDS) {
      const m = VIDEO_MODELS[id];
      expect(m.id).not.toMatch(forbidden);
      expect(m.name).not.toMatch(forbidden);
      expect(m.summary).not.toMatch(forbidden);
      expect(m.id.startsWith('sociafy-')).toBe(true);
    }
  });

  it('maps backends to public ids without ever returning the raw column', () => {
    expect(modelForBackend('cue-h3')).toBe('sociafy-cinema-1');
    expect(modelForBackend('piapi-seedance-2')).toBe('sociafy-motion-1');
    expect(modelForBackend('piapi-seedance-2-fast')).toBe('sociafy-motion-1');
    // Legacy and unknown rows resolve to a real model, never to null or the
    // backend string itself.
    expect(modelForBackend(null)).toBe(DEFAULT_VIDEO_MODEL);
    expect(modelForBackend('something-new')).toBe(DEFAULT_VIDEO_MODEL);
  });

  it('routes a public id to the right backend', () => {
    expect(backendFor('sociafy-cinema-1', false)).toBe('cue-h3');
    // Cinema has one speed; `fast` must not route it somewhere else.
    expect(backendFor('sociafy-cinema-1', true)).toBe('cue-h3');
    expect(backendFor('sociafy-motion-1', false)).toBe('piapi-seedance-2');
    expect(backendFor('sociafy-motion-1', true)).toBe('piapi-seedance-2-fast');
  });

  it('recognises only real ids', () => {
    expect(isVideoModelId('sociafy-cinema-1')).toBe(true);
    expect(isVideoModelId('cue-h3')).toBe(false);
    expect(isVideoModelId(undefined)).toBe(false);
  });
});

describe('validateAgainstModel', () => {
  it('accepts what each model publishes', () => {
    expect(validateAgainstModel('sociafy-motion-1', base)).toBeNull();
    expect(validateAgainstModel('sociafy-cinema-1', base)).toBeNull();
    expect(validateAgainstModel('sociafy-cinema-1', { ...base, durationSec: 30 })).toBeNull();
  });

  it('refuses Cinema at 1080p rather than quietly serving 720p', () => {
    const bad = validateAgainstModel('sociafy-cinema-1', { ...base, quality: '1080p' });
    expect(bad?.field).toBe('quality');
    // The message has to name the real options, or the caller cannot fix it.
    expect(bad?.message).toContain('480p');
    expect(bad?.message).toContain('720p');
    // ...and Motion genuinely does offer it, so this is per-model, not global.
    expect(validateAgainstModel('sociafy-motion-1', { ...base, quality: '1080p' })).toBeNull();
  });

  it('holds each model to its own duration range', () => {
    expect(validateAgainstModel('sociafy-motion-1', { ...base, durationSec: 30 })?.field).toBe('duration_sec');
    expect(validateAgainstModel('sociafy-cinema-1', { ...base, durationSec: 31 })?.field).toBe('duration_sec');
    expect(validateAgainstModel('sociafy-cinema-1', { ...base, durationSec: 3 })?.field).toBe('duration_sec');
  });

  it('accepts frames on Cinema — its backend takes first_frame/last_frame', () => {
    expect(validateAgainstModel('sociafy-cinema-1', { ...base, genMode: 'image-to-video' })).toBeNull();
  });

  it('still withholds `reference` on Cinema, and only that', () => {
    // ref_images switches the backend into a different render mode whose price
    // we have not measured, and Cinema bills from a live quote — an unmeasured
    // mode is an unpriced one.
    const bad = validateAgainstModel('sociafy-cinema-1', { ...base, genMode: 'reference' });
    expect(bad?.field).toBe('gen_mode');
    expect(bad?.message).toContain('image-to-video');
    expect(validateAgainstModel('sociafy-motion-1', { ...base, genMode: 'reference' })).toBeNull();
  });

  it('treats `fast` as a hint, not an error, on a single-speed model', () => {
    expect(validateAgainstModel('sociafy-cinema-1', { ...base, fast: true })).toBeNull();
  });
});

describe('creditsFromProviderUsd', () => {
  it('holds the same margin basis as the rest of the price table', () => {
    // 112.5 cr per provider dollar — the ratio 8s/720p/Quality already encodes
    // (180 cr for a $1.60 cost). Cinema must not silently undercut it.
    expect(CREDITS_PER_PROVIDER_USD).toBe(112.5);
    expect(creditsFromProviderUsd(1.6)).toBe(180);
  });

  it('rounds up, so a sub-credit render is never free', () => {
    expect(creditsFromProviderUsd(0.0001)).toBe(1);
    // Observed backend quotes: 4s, 8s and 30s at full canvas.
    expect(creditsFromProviderUsd(0.113)).toBe(13);
    expect(creditsFromProviderUsd(0.291)).toBe(33);
    expect(creditsFromProviderUsd(2.564)).toBe(289);
  });
});

describe('encodeCinemaFrames', () => {
  it('encodes frames in the order given', () => {
    const out = encodeCinemaFrames([Buffer.from('first'), Buffer.from('last')]);
    expect(out).toEqual([Buffer.from('first').toString('base64'), Buffer.from('last').toString('base64')]);
  });

  it('refuses a set that would 413 upstream, and says how big it was', () => {
    // The proxy in front of the render backend drops an oversized body
    // outright. This has to throw BEFORE the charge, or it is a refund to
    // explain for a limit we could have checked up front.
    const big = Buffer.alloc(CINEMA_MAX_ATTACHMENT_B64); // base64 is ~4/3 of this
    expect(() => encodeCinemaFrames([big])).toThrow(CinemaAttachmentTooLarge);
    try {
      encodeCinemaFrames([big]);
    } catch (e) {
      expect((e as InstanceType<typeof CinemaAttachmentTooLarge>).totalB64).toBeGreaterThan(CINEMA_MAX_ATTACHMENT_B64);
    }
  });

  it('counts the whole set, not each frame', () => {
    // Two frames that each fit but together do not must still be refused.
    const half = Buffer.alloc(Math.floor((CINEMA_MAX_ATTACHMENT_B64 * 3) / 4) - 1_000);
    expect(() => encodeCinemaFrames([half])).not.toThrow();
    expect(() => encodeCinemaFrames([half, half])).toThrow(CinemaAttachmentTooLarge);
  });
});
