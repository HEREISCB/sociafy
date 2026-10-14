import { describe, it, expect, vi } from 'vitest';

const ai = vi.hoisted(() => ({ text: '' as string | Error, configured: true }));
vi.mock('./client', () => ({
  getTextAI: () => (ai.configured ? { kind: 'openai', model: 'm' } : null),
  completeText: () => (ai.text instanceof Error ? Promise.reject(ai.text) : Promise.resolve(ai.text)),
}));

import { buildMotionCopyPrompt, coerceMotionCopy, writeMotionCopy, type MotionCopyInput } from './motionCopy';
import { motionReady, motionVariables } from '../brand/kit';

const input = (over: Partial<MotionCopyInput> = {}): MotionCopyInput => ({
  template: 'stat',
  topic: 'We now answer calls in Hindi and Tamil. Setup takes a day.',
  brandName: 'IndusLabs',
  facts: ['40% fewer missed calls', '12 languages', 'Live in 1 day'],
  ...over,
});

describe('buildMotionCopyPrompt', () => {
  it('lists only the approved facts, indexed, and forbids inventing numbers', () => {
    const p = buildMotionCopyPrompt(input());
    expect(p.user).toContain('0. 40% fewer missed calls');
    expect(p.user).toContain('2. Live in 1 day');
    expect(p.user).toContain('TOPIC: We now answer calls');
    expect(p.system).toMatch(/NEVER write a number/);
    expect(p.system).toContain('IndusLabs');
  });

  it('says so when there are no facts, and asks showcase for captions', () => {
    const p = buildMotionCopyPrompt(input({ template: 'showcase', facts: [] }));
    expect(p.user).toContain('(none)');
    expect(p.system).toMatch(/captions/);
  });
});

describe('coerceMotionCopy', () => {
  it('takes facts only by valid index, verbatim, deduped, max 3', () => {
    const c = coerceMotionCopy({ hook: 'Every call, *answered*', lines: ['Try it today'], factIndexes: [2, 2, 9, -1, 0, 'x'] }, input());
    expect(c.facts).toEqual(['Live in 1 day', '40% fewer missed calls']);
    expect(c).toMatchObject({ hook: 'Every call, *answered*', lines: ['Try it today'] });
  });

  it('drops free text carrying a number (an unapproved stat)', () => {
    const c = coerceMotionCopy({ hook: '3x faster replies', lines: ['99% uptime', 'Ready now'] }, input());
    expect(c.hook).toBe('We now answer calls in Hindi and Tamil.'); // fallback from the topic
    expect(c.lines).toEqual(['Ready now']);
  });

  it('caps lengths and line counts per template', () => {
    const long = 'word '.repeat(40);
    const stat = coerceMotionCopy({ hook: long, lines: ['a', 'b', 'c'] }, input());
    expect(stat.hook.length).toBeLessThanOrEqual(70);
    expect(stat.lines).toEqual(['a']);
    const show = coerceMotionCopy({ hook: 'x', lines: ['a', 'b', 'c', 'd', 'e'] }, input({ template: 'showcase' }));
    expect(show.lines).toHaveLength(4);
  });

  it('survives garbage: falls back to the topic and the kit facts', () => {
    for (const raw of ['not json', null, 42, '[]']) {
      const c = coerceMotionCopy(raw, input());
      expect(c.hook).toBe('We now answer calls in Hindi and Tamil.');
      expect(c.facts).toEqual(input().facts);
      expect(c.lines).toEqual([]);
    }
  });
});

describe('writeMotionCopy', () => {
  it('parses the model JSON', async () => {
    ai.configured = true;
    ai.text = JSON.stringify({ hook: 'Calls, *handled*', lines: ['Book a demo'], factIndexes: [1] });
    await expect(writeMotionCopy(input())).resolves.toEqual({ hook: 'Calls, *handled*', lines: ['Book a demo'], facts: ['12 languages'] });
  });

  it('falls back on a failed call or no AI, and skips the call for a sting', async () => {
    ai.text = new Error('timeout');
    expect((await writeMotionCopy(input())).facts).toHaveLength(3);
    ai.configured = false;
    expect((await writeMotionCopy(input())).hook).toBeTruthy();
    expect(await writeMotionCopy(input({ template: 'sting' }))).toEqual({ hook: '', lines: [], facts: [] });
  });
});

describe('brand kit → motion variables', () => {
  const logo = { id: 'a', url: 'https://cdn/logo.svg', mime: 'image/svg+xml' };
  it('motionReady needs name + logo + primary color', () => {
    expect(motionReady({ logo: { primary: logo }, colors: { primary: '#5B5EF2' } }, { companyName: 'X' })).toBe(true);
    expect(motionReady({ logo: { primary: logo } }, { companyName: 'X' })).toBe(false);
    expect(motionReady({ logo: { primary: logo }, colors: { primary: '#5B5EF2' } }, { companyName: ' ' })).toBe(false);
  });

  it('merges copy, and leaves fonts to the template when none is chosen', () => {
    const v = motionVariables({ colors: { primary: '#5B5EF2' }, facts: ['a', 'b'] }, { companyName: 'X' }, { hook: 'H', lines: ['L'], facts: [] });
    expect(v).toMatchObject({ brandName: 'X', hook: 'H', lines: ['L'], facts: ['a', 'b'], fontDisplayUrl: '', fontBodyUrl: '' });
    const f = motionVariables({ fonts: { display: { source: 'google', family: 'Lora' } } }, {}, { hook: '', lines: [], facts: ['z'] });
    expect(f.fontDisplayUrl).toMatch(/fonts\.googleapis\.com.*Lora/);
    expect(f.facts).toEqual(['z']);
  });
});
