import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CREDIT_PRICES as P } from '../../lib/credits/pricing';

// /developers imports CREDIT_PRICES, so the on-page prices cannot drift. The
// hand-maintained copy is docs/api.md — which the page now links to as the full
// reference, so a price changed in pricing.ts and not here would have the app
// contradicting its own docs. That is what this guards.
const root = path.resolve(__dirname, '../..');
const doc = fs.readFileSync(path.join(root, 'docs/api.md'), 'utf8');

describe('docs/api.md agrees with the credit price table', () => {
  it.each([
    ['video 4–12s', `| 480p | ${P.video_8s_480p_fast} | ${P.video_8s_480p_quality} |`],
    ['video 4–12s', `| 720p | ${P.video_8s_720p_fast} | ${P.video_8s_720p_quality} |`],
    ['video 4–12s', `| 1080p | — | ${P.video_8s_1080p_quality} |`],
    ['video 13–15s', `| 480p | ${P.video_15s_480p_quality} |`],
    ['video 13–15s', `| 720p | ${P.video_15s_720p_quality} |`],
    ['video 13–15s', `| 1080p | ${P.video_15s_1080p_quality} |`],
    ['images', `| low | ${P.image_low_1024} | ${P.image_low_1024} |`],
    ['images', `| medium | ${P.image_medium_1024} | ${P.image_medium_portrait} |`],
    ['images', `| high | ${P.image_high_1024} | ${P.image_high_portrait} |`],
  ])('%s row %s', (_section, row) => {
    expect(doc).toContain(row);
  });
});

describe('key-management location', () => {
  it('docs point at /developers, not the retired /usage anchor', () => {
    expect(doc).toContain('/developers');
    expect(doc).not.toContain('/usage#api-keys');
  });

  it('the daily-cap 429 sends developers to /developers', () => {
    const src = fs.readFileSync(path.join(root, 'lib/api-key.ts'), 'utf8');
    const hint = src.split('\n').find((l) => l.includes('credit daily cap.'));
    expect(hint).toContain('/developers');
  });
});
