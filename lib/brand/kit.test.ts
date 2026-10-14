import { describe, expect, it } from 'vitest';
import { brandKitCompleteness, brandVariables, contrastRatio, googleFontCssUrl, resolveColors } from './kit';
import { brandKitPatchSchema, brandKitSchema } from '../validation';

const asset = (mime: string, n = 1) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, url: `https://cdn.example/${n}`, mime });

describe('contrastRatio', () => {
  it('matches WCAG extremes', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('resolveColors', () => {
  it('derives every role from primary', () => {
    const c = resolveColors({ primary: '#3355ff' });
    expect(c.primary).toBe('#3355FF');
    expect(c.secondary).not.toBe(c.primary);
    expect(c.accent).toBe(c.secondary);
    expect(contrastRatio(c.text, c.background)).toBeGreaterThanOrEqual(4.5);
  });
  it('picks light text on a dark background', () => {
    expect(resolveColors({ background: '#101010' }).text).toBe('#FFFFFF');
  });
  it('keeps what the user set', () => {
    expect(resolveColors({ primary: '#111111', accent: '#ff0000' }).accent).toBe('#FF0000');
  });
});

describe('brandVariables', () => {
  it('falls back sanely on an empty kit', () => {
    const v = brandVariables({});
    expect(v).toMatchObject({
      brandName: '', tagline: '', cta: '', ctaUrl: '', fontDisplay: 'Inter', fontBody: 'Inter',
      logoUrl: null, logoReverseUrl: null, facts: [], screenshots: [], musicMood: 'calm', style: 'soft',
    });
    expect(v.fontDisplayUrl).toBe(googleFontCssUrl('Inter'));
    expect(Object.keys(v.colors)).toEqual(['primary', 'secondary', 'background', 'text', 'accent']);
  });
  it('maps a full kit', () => {
    const v = brandVariables(
      {
        tagline: 'Ship faster',
        logo: { primary: asset('image/svg+xml', 1), mono: asset('image/png', 2) },
        fonts: { display: { source: 'google', family: 'Space Grotesk' }, body: { source: 'upload', family: 'Acme', asset: asset('font/woff2', 3), licensed: true } },
        facts: ['10k teams'],
        screenshots: [asset('image/png', 4)],
        music: { mood: 'upbeat' },
        video: { style: 'bold' },
      },
      { companyName: 'Acme', website: 'https://www.acme.com/start' },
    );
    expect(v).toMatchObject({
      brandName: 'Acme', tagline: 'Ship faster', cta: 'acme.com', ctaUrl: 'https://www.acme.com/start',
      logoUrl: 'https://cdn.example/1', logoReverseUrl: 'https://cdn.example/2',
      fontDisplay: 'Space Grotesk', fontBody: 'Acme', fontBodyUrl: 'https://cdn.example/3',
      facts: ['10k teams'], screenshots: ['https://cdn.example/4'], musicMood: 'upbeat', style: 'bold',
    });
    expect(v.fontDisplayUrl).toBe('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700&display=swap');
  });
  it('prefers the end-card text over the website host', () => {
    expect(brandVariables({ video: { endCardCta: 'Try it free' } }, { website: 'https://acme.com' }).cta).toBe('Try it free');
  });
});

describe('brandKitCompleteness', () => {
  it('counts filled items', () => {
    expect(brandKitCompleteness({}, { companyName: null })).toMatchObject({ done: 0, total: 11 });
    const c = brandKitCompleteness({ colors: { primary: '#000000' }, facts: ['x'], voice: { tone: [] } }, { companyName: 'Acme' });
    expect(c.done).toBe(3);
    expect(c.items.voice).toBe(false);
  });
});

describe('brandKitSchema', () => {
  it('rejects a font upload without the license box', () => {
    const font = { source: 'upload', family: 'Acme', asset: asset('font/woff2') };
    expect(brandKitSchema.safeParse({ fonts: { display: font } }).success).toBe(false);
    expect(brandKitSchema.safeParse({ fonts: { display: { ...font, licensed: true } } }).success).toBe(true);
  });
  it('keeps each slot to its file type', () => {
    expect(brandKitSchema.safeParse({ logo: { primary: asset('application/pdf') } }).success).toBe(false);
    expect(brandKitSchema.safeParse({ guidePdf: asset('application/pdf') }).success).toBe(true);
  });
  it('caps facts, screenshots and tagline', () => {
    expect(brandKitSchema.safeParse({ facts: Array(7).fill('x') }).success).toBe(false);
    expect(brandKitSchema.safeParse({ screenshots: Array(9).fill(asset('image/png')) }).success).toBe(false);
    expect(brandKitSchema.safeParse({ tagline: 'x'.repeat(61) }).success).toBe(false);
  });
  it('rejects fonts outside the curated list and bad hex', () => {
    expect(brandKitSchema.safeParse({ fonts: { display: { source: 'google', family: 'Comic Sans' } } }).success).toBe(false);
    expect(brandKitSchema.safeParse({ colors: { primary: 'red' } }).success).toBe(false);
  });
  it('patch allows null to clear the guide', () => {
    expect(brandKitPatchSchema.safeParse({ guidePdf: null, narratorVoiceId: null }).success).toBe(true);
  });
});
