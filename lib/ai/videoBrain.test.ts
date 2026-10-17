import { describe, it, expect, vi, beforeEach } from 'vitest';

const st = vi.hoisted(() => ({ ai: null as null | object, reply: '' }));
vi.mock('./client', () => ({
  getTextAI: () => st.ai,
  completeText: () => Promise.resolve(st.reply),
}));

import {
  FOOTAGE_NEGATIVE, VENDOR_RX, alternativesFor, cinemaEstimate, draftFromPlan, finalizePlan, heuristicDraft,
  planVideo, priceForPlan, summaryFor, type Availability, type BrainInput, type Draft, type Plan,
} from './videoBrain';

const ALL: Availability = { motion1: true, cinema: true, templates: true, aiMotion: true, kitScreenshots: 0 };
const input = (over: Partial<BrainInput> = {}): BrainInput => ({
  text: 'Sunday mornings at our bakery: flour, butter, first light.',
  platforms: ['instagram'],
  attachments: [],
  availability: ALL,
  balance: 100_000,
  ...over,
});
const draft = (d: Draft): Draft => ({ confidence: 0.9, ...d });
const PHOTO = [{ url: 'https://cdn.example/bottle.jpg', mimeType: 'image/jpeg' }];

beforeEach(() => { st.ai = null; st.reply = ''; });

describe('priceForPlan', () => {
  const base = { durationSec: 12, audio: { narration: false, music: false, sfx: true }, graphics: null, footage: null };
  const fast6 = { engine: 'motion-1-fast' as const, mode: 'text' as const, seconds: 6, quality: '720p' as const, prompt: '' };
  it.each([
    ['ai motion 12 s silent', { ...base, format: 'motion_graphic', graphics: { engine: 'ai_motion', template: null } }, 216],
    ['ai motion 12 s + music', { ...base, format: 'motion_graphic', graphics: { engine: 'ai_motion', template: null }, audio: { narration: false, music: true, sfx: true } }, 264],
    ['stat template', { ...base, format: 'motion_graphic', graphics: { engine: 'template', template: 'stat' } }, 270],
    ['showcase template', { ...base, format: 'motion_graphic', graphics: { engine: 'template', template: 'showcase' } }, 288],
    ['sting template', { ...base, format: 'motion_graphic', graphics: { engine: 'template', template: 'sting' } }, 126],
    ['ai video fast 8 s 720p', { ...base, format: 'ai_video', footage: { ...fast6, seconds: 8 } }, 145],
    ['ai video quality 5 s 720p', { ...base, format: 'ai_video', footage: { ...fast6, engine: 'motion-1', seconds: 5 } }, 197],
    ['ai video quality 8 s 1080p', { ...base, format: 'ai_video', footage: { ...fast6, engine: 'motion-1', seconds: 8, quality: '1080p' } }, 720],
    ['ai video cinema 8 s', { ...base, format: 'ai_video', footage: { ...fast6, engine: 'cinema-1', seconds: 8 } }, 33],
    ['hybrid fast 6 s + 12 s music', { ...base, format: 'hybrid', footage: fast6, graphics: { engine: 'ai_motion', template: null }, audio: { narration: false, music: true, sfx: true } }, 109 + 264],
    ['none', { ...base, format: 'none' }, 0],
  ])('%s', (_name, plan, credits) => {
    expect(priceForPlan(plan as Plan)).toBe(credits);
  });

  it('pins Cinema to its published curve, monotone in length', () => {
    expect([4, 6, 8, 15, 30].map(cinemaEstimate)).toEqual([13, 23, 33, 92, 288]);
  });
});

describe('finalizePlan: availability', () => {
  it('hybrid without the AI motion worker → template graphic; without footage engines → AI motion', () => {
    const hy = draft({ format: 'hybrid', footageEngine: 'motion-1-fast', footageSeconds: 6, template: 'stat' });
    expect(finalizePlan(hy, input({ availability: { ...ALL, aiMotion: false } }))).toMatchObject({ format: 'motion_graphic', graphics: { engine: 'template' } });
    expect(finalizePlan(hy, input({ availability: { ...ALL, motion1: false, cinema: false } }))).toMatchObject({ format: 'motion_graphic', graphics: { engine: 'ai_motion' } });
  });

  it('ai_video with no footage engine → motion graphic; graphics with none → ai video; nothing → none', () => {
    expect(finalizePlan(draft({ format: 'ai_video' }), input({ availability: { ...ALL, motion1: false, cinema: false } })).format).toBe('motion_graphic');
    expect(finalizePlan(draft({ format: 'motion_graphic' }), input({ availability: { ...ALL, aiMotion: false, templates: false } })).format).toBe('ai_video');
    const none = finalizePlan(draft({ format: 'motion_graphic' }), input({ availability: { motion1: false, cinema: false, templates: false, aiMotion: false } }));
    expect(none).toMatchObject({ format: 'none', reason: 'unavailable', estimatedCredits: 0 });
  });

  it('Motion 1 unavailable → ai video falls to Cinema', () => {
    const p = finalizePlan(draft({ format: 'ai_video', footageEngine: 'motion-1' }), input({ availability: { ...ALL, motion1: false } }));
    expect(p.footage?.engine).toBe('cinema-1');
  });
});

describe('finalizePlan: policy gate', () => {
  it('a real person in the post forces graphics, whatever the model says', () => {
    const p = finalizePlan(draft({ format: 'ai_video', videoAllowed: true }), input({ text: 'Congrats to our CEO Priya on Forbes 30u30!' }));
    expect(p.format).toBe('motion_graphic');
    expect(p.footage).toBeNull();
    expect(p.signals).toContain('S11');
  });
  it('the model can close the gate, and a footage prompt naming a child closes it too', () => {
    expect(finalizePlan(draft({ format: 'hybrid', videoAllowed: false }), input()).format).toBe('motion_graphic');
    expect(finalizePlan(draft({ format: 'ai_video', footagePrompt: 'a child laughing in a field' }), input()).format).toBe('motion_graphic');
  });
});

describe('finalizePlan: envelopes', () => {
  it('Fast and Cinema top out at 720p; Motion 1 at 15 s', () => {
    const p = finalizePlan(draft({ format: 'ai_video', footageEngine: 'motion-1-fast', footageQuality: '1080p', durationSec: 30 }), input());
    expect(p.footage).toMatchObject({ engine: 'motion-1-fast', quality: '720p', seconds: 15 });
    expect(p.durationSec).toBe(15);
    expect(p.audio).toEqual({ narration: false, music: false, sfx: false }); // Motion is mute
  });

  it('Cinema only within its deadline, never in a hybrid, always text mode', () => {
    const long = finalizePlan(draft({ format: 'ai_video', footageEngine: 'cinema-1', durationSec: 15 }), input());
    expect(long.footage?.engine).toBe('motion-1-fast'); // 15 s Cinema ≈ 16 min × 3 > 30 min default
    const ok = finalizePlan(draft({ format: 'ai_video', footageEngine: 'cinema-1', durationSec: 15 }), input({ deadlineMin: 120 }));
    expect(ok.footage?.engine).toBe('cinema-1');
    const hy = finalizePlan(draft({ format: 'hybrid', footageEngine: 'cinema-1' }), input());
    expect(hy.footage?.engine).toBe('motion-1-fast');
    const i2v = finalizePlan(draft({ format: 'ai_video', footageEngine: 'cinema-1', footageMode: 'image-to-video', durationSec: 8 }), input({ attachments: PHOTO }));
    expect(i2v.footage).toMatchObject({ engine: 'cinema-1', mode: 'text' });
  });

  it('AI motion 6–20 s; hybrid footage 4–8 s and shorter than the video', () => {
    expect(finalizePlan(draft({ format: 'motion_graphic', durationSec: 40 }), input()).durationSec).toBe(20);
    expect(finalizePlan(draft({ format: 'motion_graphic', durationSec: 2 }), input()).durationSec).toBe(6);
    const hy = finalizePlan(draft({ format: 'hybrid', footageSeconds: 14, durationSec: 12 }), input());
    expect(hy.footage?.seconds).toBe(8);
    const short = finalizePlan(draft({ format: 'hybrid', footageSeconds: 1, durationSec: 6 }), input());
    expect(short.footage?.seconds).toBe(4);
    expect(short.durationSec).toBe(6);
  });

  it('templates: fixed length, silent, no 1:1 (→ AI motion, or a wide template when AI motion is off)', () => {
    const t = finalizePlan(draft({ format: 'motion_graphic', graphicsEngine: 'template', template: 'stat', durationSec: 9 }), input({ platforms: ['instagram'] }));
    expect(t).toMatchObject({ graphics: { engine: 'template', template: 'stat' }, durationSec: 15, estimatedCredits: 270 });
    expect(t.audio).toEqual({ narration: false, music: false, sfx: false });
    const sq = finalizePlan(draft({ format: 'motion_graphic', graphicsEngine: 'template', template: 'stat' }), input({ platforms: ['linkedin'] }));
    expect(sq).toMatchObject({ aspect: '1:1', graphics: { engine: 'ai_motion' } });
    const wide = finalizePlan(draft({ format: 'motion_graphic', graphicsEngine: 'template', template: 'stat' }), input({ platforms: ['linkedin'], availability: { ...ALL, aiMotion: false } }));
    expect(wide).toMatchObject({ aspect: '16:9', graphics: { engine: 'template', template: 'stat' } });
  });

  it('showcase needs kit screenshots; non-Latin text needs AI motion', () => {
    expect(finalizePlan(draft({ format: 'motion_graphic', graphicsEngine: 'template', template: 'showcase' }), input()).graphics?.engine).toBe('ai_motion');
    expect(finalizePlan(draft({ format: 'motion_graphic', graphicsEngine: 'template', template: 'showcase' }), input({ availability: { ...ALL, kitScreenshots: 3 } })).graphics?.template).toBe('showcase');
    expect(finalizePlan(draft({ format: 'motion_graphic', graphicsEngine: 'template', template: 'stat' }), input({ text: 'Cold brew ₹199 this weekend' })).graphics?.engine).toBe('ai_motion');
  });

  it('image modes need an image; feed-only platforms are muted to SFX', () => {
    expect(finalizePlan(draft({ format: 'ai_video', footageMode: 'image-to-video' }), input()).footage?.mode).toBe('text');
    expect(finalizePlan(draft({ format: 'ai_video', footageEngine: 'motion-1', footageMode: 'image-to-video' }), input({ attachments: PHOTO })).footage?.mode).toBe('image-to-video');
    const li = finalizePlan(draft({ format: 'motion_graphic', audio: { narration: true, music: true } }), input({ platforms: ['linkedin', 'x'] }));
    expect(li.audio).toEqual({ narration: false, music: false, sfx: true });
  });

  it("recomputes the price, never trusting the draft's number", () => {
    const p = finalizePlan({ ...draft({ format: 'motion_graphic', durationSec: 12, audio: { music: false } }), estimatedCredits: 1 } as Draft, input());
    expect(p.estimatedCredits).toBe(216);
  });

  it('hybrids carry the AI motion fallback price; other formats none', () => {
    const hy = finalizePlan(draft({ format: 'hybrid', durationSec: 12, audio: { music: true } }), input());
    expect(hy.fallback).toEqual({ format: 'motion_graphic', estimatedCredits: 264 });
    expect(finalizePlan(draft({ format: 'ai_video' }), input()).fallback).toBeNull();
  });
});

describe('finalizePlan: footage prompt', () => {
  it('always forbids text, signage, screens, UI, holograms, captions and logos; strips what must be legible', () => {
    for (const format of ['ai_video', 'hybrid'] as const) {
      const p = finalizePlan(draft({ format, footagePrompt: 'Courier on a scooter past a sign reading "40% OFF", 2 holographic screens' }), input());
      const prompt = p.footage!.prompt;
      expect(prompt).toContain(FOOTAGE_NEGATIVE);
      for (const w of ['no on-screen text', 'no signage', 'no screens', 'no ui', 'no holograms', 'no captions', 'no logos']) expect(prompt.toLowerCase()).toContain(w);
      expect(prompt).not.toMatch(/40|OFF"|\d/);
      expect(prompt).toMatch(/No identifiable faces/);
    }
  });
  it('the heuristic writes one from the post when the model gave none', () => {
    const p = finalizePlan(draft({ format: 'ai_video' }), input());
    expect(p.footage!.prompt).toMatch(/bakery/);
    expect(p.footage!.prompt).toContain(FOOTAGE_NEGATIVE);
  });
});

describe('finalizePlan: cost ceiling and downgrade ladder', () => {
  const pricey = draft({ format: 'hybrid', footageEngine: 'motion-1', footageQuality: '1080p', footageSeconds: 6, durationSec: 15, audio: { music: true } });

  it('a small balance walks the ladder down to the sting template', () => {
    const p = finalizePlan(pricey, input({ balance: 400 }));
    expect(p).toMatchObject({ format: 'motion_graphic', graphics: { engine: 'template', template: 'sting' }, estimatedCredits: 126 });
    expect(p.reasons).toContain('Scaled down to fit your credit balance.');
  });

  it('a chosen format is never changed — only made cheaper inside it', () => {
    const p = finalizePlan(pricey, input({ balance: 400, overrides: { format: 'hybrid' } }));
    expect(p.format).toBe('hybrid');
    expect(p.footage).toMatchObject({ engine: 'motion-1-fast', quality: '720p' });
    expect(p.estimatedCredits).toBeLessThanOrEqual(400);
  });

  it('first step is 1080p → 720p, and a big balance changes nothing', () => {
    const rich = finalizePlan(pricey, input());
    expect(rich.footage).toMatchObject({ engine: 'motion-1', quality: '1080p' });
    // ceiling = 25% of 4000 = 1000; 6 s 1080p (540) + 15 s music (330) = 870 fits; no step needed.
    expect(finalizePlan(pricey, input({ balance: 4_000 })).footage?.quality).toBe('1080p');
    // 25% of 3000 = 750 < 870 → one step (720p: 236 + 330 = 566) is enough.
    expect(finalizePlan(pricey, input({ balance: 3_000 })).footage).toMatchObject({ engine: 'motion-1', quality: '720p' });
  });

  it('cheapest viable above the balance → none, insufficient_credits', () => {
    expect(finalizePlan(pricey, input({ balance: 100 }))).toMatchObject({ format: 'none', reason: 'insufficient_credits' });
  });
});

describe('finalizePlan: safe default', () => {
  it.each([
    ['low confidence', draft({ format: 'ai_video', confidence: 0.3 })],
    ['parse failure', null],
  ])('%s → AI motion, 12 s, platform aspect, SFX only, 216 cr', (_n, d) => {
    const p = finalizePlan(d, input({ platforms: ['tiktok'] }));
    expect(p).toMatchObject({ format: 'motion_graphic', graphics: { engine: 'ai_motion' }, durationSec: 12, aspect: '9:16', estimatedCredits: 216 });
    expect(p.audio).toEqual({ narration: false, music: false, sfx: true });
  });
});

describe('heuristicDraft', () => {
  const plan = (text: string, platforms = ['instagram'], attachments: BrainInput['attachments'] = []) =>
    finalizePlan(heuristicDraft({ text, platforms, attachments }), input({ text, platforms, attachments }));

  it('scene → AI video; stat + scene → hybrid H2; numbers → graphic; real person → graphic', () => {
    expect(plan('Sunday mornings at our bakery: flour, butter, first light.')).toMatchObject({ format: 'ai_video', footage: { engine: 'motion-1-fast' } });
    expect(plan('We cut delivery times 40% across Pune.')).toMatchObject({ format: 'hybrid', recipe: 'H2' });
    expect(plan('Onboarding used to take 3 days. Now 20 minutes.', ['linkedin']).format).toBe('motion_graphic');
    expect(plan('Congrats to our CEO Priya on Forbes 30u30!').format).toBe('motion_graphic');
  });
  it('product photo + price → hybrid H3 image-to-video on Motion 1', () => {
    const p = plan('Our new cold brew is here. ₹199 this weekend only.', ['instagram'], PHOTO);
    expect(p).toMatchObject({ format: 'hybrid', recipe: 'H3', footage: { engine: 'motion-1', mode: 'image-to-video' } });
  });
  it('nothing clear → safe default', () => {
    expect(plan('Thinking about what comes next.')).toMatchObject({ format: 'motion_graphic', durationSec: 12, estimatedCredits: 216 });
  });
});

describe('customer copy', () => {
  it('summaries, reasons and the plan never name a vendor', () => {
    const drafts: (Draft | null)[] = [
      draft({ format: 'ai_video' }), draft({ format: 'ai_video', footageEngine: 'cinema-1', durationSec: 8 }),
      draft({ format: 'hybrid' }), draft({ format: 'motion_graphic', graphicsEngine: 'template', template: 'stat' }),
      draft({ format: 'motion_graphic' }), null,
    ];
    for (const d of drafts) {
      const p = finalizePlan(d, input());
      expect(summaryFor(p)).not.toMatch(VENDOR_RX);
      for (const r of p.reasons) expect(r).not.toMatch(VENDOR_RX);
      expect(JSON.stringify(p)).not.toMatch(VENDOR_RX);
    }
    expect(summaryFor(finalizePlan(draft({ format: 'ai_video', footageEngine: 'cinema-1', durationSec: 8 }), input()))).toMatch(/Sociafy Cinema 1/);
  });

  it('alternatives: up to two, each a different format, cheapest first', () => {
    const p = finalizePlan(draft({ format: 'hybrid' }), input());
    const alts = alternativesFor(p, input(), draft({ format: 'hybrid' }));
    expect(alts.length).toBeLessThanOrEqual(2);
    expect(alts.map((a) => a.format)).not.toContain('hybrid');
    expect(alts.map((a) => a.estimatedCredits)).toEqual([...alts.map((a) => a.estimatedCredits)].sort((a, b) => a - b));
  });
});

describe('revalidation (generate-auto)', () => {
  it('round-trips an approved plan to the same price, and clamps a tampered one', () => {
    const p = finalizePlan(draft({ format: 'hybrid', footageSeconds: 6, durationSec: 12, audio: { music: true } }), input());
    const again = finalizePlan(draftFromPlan(p), input({ overrides: { format: 'hybrid', durationSec: p.durationSec, aspect: p.aspect } }), { revalidate: true });
    expect(again.estimatedCredits).toBe(p.estimatedCredits);
    expect(again.footage!.prompt).toBe(p.footage!.prompt);
    const tampered = { ...p, footage: { ...p.footage!, seconds: 15, quality: '1080p' as const, engine: 'motion-1-fast' as const } };
    const fixed = finalizePlan(draftFromPlan(tampered), input({ overrides: { format: 'hybrid' } }), { revalidate: true });
    expect(fixed.footage).toMatchObject({ seconds: 8, quality: '720p' });
  });
});

describe('planVideo', () => {
  it('no LLM configured → the heuristic plans it', async () => {
    const r = await planVideo(input());
    expect(r.plan.format).toBe('ai_video');
    expect(r.summary).toMatch(/AI video/);
    expect(r.estimatedCredits).toBe(r.plan.estimatedCredits);
  });
  it('unparseable LLM output → heuristic; valid output → used', async () => {
    st.ai = { kind: 'openai' };
    st.reply = 'not json';
    expect((await planVideo(input())).plan.format).toBe('ai_video');
    st.reply = JSON.stringify({ format: 'motion_graphic', graphicsEngine: 'ai_motion', durationSec: 10, confidence: 0.9 });
    expect((await planVideo(input())).plan).toMatchObject({ format: 'motion_graphic', durationSec: 10 });
  });
});
