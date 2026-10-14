import { describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ db: () => { throw new Error('no db in tests'); } }));
import { loadBrandKit, renderBrandBlock, type BrandContext } from './brand-context';

const base: BrandContext = {
  companyName: 'Acme', brandBio: null, website: null, brandBrief: null, niches: [],
  voiceTemplate: null, instructions: null, brandSafetyStrict: false,
};
const kit = {
  tagline: 'Ship faster',
  voice: { tone: ['warm', 'direct'], do: ['we'], dont: ['synergy'] },
  facts: ['10k teams'],
  colors: { primary: '#3355FF', text: '#111111' },
};

describe('renderBrandBlock with a brand kit', () => {
  it('adds tagline, voice and facts to text prompts, not colors', () => {
    const out = renderBrandBlock({ ...base, kit }, 'text');
    expect(out).toContain('Tagline: Ship faster');
    expect(out).toContain('Tone: warm, direct');
    expect(out).toContain('Never say: synergy');
    expect(out).toContain('10k teams');
    expect(out).not.toContain('#3355FF');
  });
  it('adds tagline and colors to media prompts, not voice or facts', () => {
    const out = renderBrandBlock({ ...base, kit }, 'media');
    expect(out).toContain('Tagline: Ship faster');
    expect(out).toContain('Brand colors: primary #3355FF');
    expect(out).not.toContain('text #111111');
    expect(out).not.toContain('Tone:');
    expect(out).not.toContain('10k teams');
  });
  it('is unchanged without a kit', () => {
    expect(renderBrandBlock(base, 'text')).toBe(renderBrandBlock({ ...base, kit: null }, 'text'));
    expect(renderBrandBlock({ ...base, companyName: null, kit: {} }, 'media')).toBe('');
  });
});

describe('loadBrandKit', () => {
  it('degrades to null when the read fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadBrandKit('u1')).toBeNull();
  });
});
