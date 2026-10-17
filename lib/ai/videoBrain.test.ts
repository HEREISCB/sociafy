import { describe, it, expect, vi, beforeEach } from 'vitest';

const st = vi.hoisted(() => ({ ai: null as null | object, reply: '' }));
vi.mock('./client', () => ({
  getTextAI: () => st.ai,
  getGroq: () => null,
  GROQ_MODELS: {},
  completeText: () => Promise.resolve(st.reply),
}));

import {
  FOOTAGE_NEGATIVE, VENDOR_RX, alternativesFor, cinemaEstimate, copyLine, detectSignals, draftFromPlan, finalizePlan, heuristicDraft,
  planVideo, priceForPlan, sceneProse, summaryFor, toLines, type Availability, type BrainInput, type Draft, type Plan,
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

  it('AI motion and hybrids 8–20 s; hybrid footage 4–8 s and shorter than the video', () => {
    expect(finalizePlan(draft({ format: 'motion_graphic', durationSec: 40 }), input()).durationSec).toBe(20);
    expect(finalizePlan(draft({ format: 'motion_graphic', durationSec: 2 }), input()).durationSec).toBe(8);
    const hy = finalizePlan(draft({ format: 'hybrid', footageSeconds: 14, durationSec: 12 }), input());
    expect(hy.footage?.seconds).toBe(8);
    const short = finalizePlan(draft({ format: 'hybrid', footageSeconds: 1, durationSec: 6 }), input());
    expect(short.footage?.seconds).toBe(4);
    expect(short.durationSec).toBe(8);
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
    // Only a photo-hero hybrid keeps quality-tier 1080p footage (b-roll under overlays is Fast 720p).
    const hero = draft({ ...pricey, footageMode: 'image-to-video' });
    const rich = finalizePlan(hero, input({ attachments: PHOTO }));
    expect(rich.footage).toMatchObject({ engine: 'motion-1', quality: '1080p' });
    // ceiling = 25% of 4000 = 1000; 6 s 1080p (540) + 15 s music (330) = 870 fits; no step needed.
    expect(finalizePlan(hero, input({ attachments: PHOTO, balance: 4_000 })).footage?.quality).toBe('1080p');
    // 25% of 3000 = 750 < 870 → one step (720p: 236 + 330 = 566) is enough.
    expect(finalizePlan(hero, input({ attachments: PHOTO, balance: 3_000 })).footage).toMatchObject({ engine: 'motion-1', quality: '720p' });
  });

  it('hybrid b-roll under overlays is Fast 720p even when the planner asks for 1080p quality', () => {
    expect(finalizePlan(pricey, input()).footage).toMatchObject({ engine: 'motion-1-fast', quality: '720p' });
  });

  it('cheapest viable above the balance → the best fit unchanged, priced, affordable:false + the cheapest option', () => {
    const rich = finalizePlan(pricey, input());
    const p = finalizePlan(pricey, input({ balance: 22 }));
    expect(p.format).toBe('hybrid');
    expect(p).toMatchObject({ affordable: false, estimatedCredits: rich.estimatedCredits, footage: rich.footage, durationSec: rich.durationSec });
    expect(p.cheapest).toMatchObject({ format: 'motion_graphic', estimatedCredits: 126 });
    expect(p.cheapest!.summary).toMatch(/Sting/i);
    // Reasons stay about the content, not money.
    expect(p.reasons.join(' ')).not.toMatch(/credit|balance|top up/i);
    expect(rich).toMatchObject({ affordable: true });
    expect(rich.cheapest).toBeUndefined();
  });

  it('a locked format the ladder cannot fit → still priced, affordable:false, cheapest offered', () => {
    const p = finalizePlan(pricey, input({ balance: 150, overrides: { format: 'hybrid' } }));
    expect(p).toMatchObject({ format: 'hybrid', affordable: false, cheapest: { estimatedCredits: 126 } });
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

describe('S14 (non-Latin script)', () => {
  const s14 = (text: string) => heuristicDraft({ text, platforms: ['instagram'], attachments: [] }).signals?.includes('S14');
  it.each([
    ['First order is ₹99', false],
    ['Launch day 🚀 — 50% off, €20 / £15 / $25!', false],
    ['Café crème à São Paulo', false],
    ['पहला ऑर्डर ₹99', true],
    ['新品上市', true],
  ])('%s → %s', (text, want) => expect(s14(text)).toBe(want));
});

describe('planVideo', () => {
  it('low balance: the response carries the priced best fit, affordable:false and the cheapest', async () => {
    const r = await planVideo(input(), { availability: ALL, balance: 22 });
    expect(r.plan.format).not.toBe('none');
    expect(r).toMatchObject({ affordable: false, estimatedCredits: r.plan.estimatedCredits, cheapest: { estimatedCredits: expect.any(Number) } });
    expect(r.estimatedCredits).toBeGreaterThan(22);
    expect((await planVideo(input(), input())).affordable).toBe(true);
  });

  it('caches the draft per user + post for re-plans (overrides, alternatives); balance is applied fresh', async () => {
    let calls = 0;
    const draft = () => { calls++; return Promise.resolve(draft0); };
    const draft0 = { format: 'ai_video', footageEngine: 'motion-1-fast', confidence: 0.9 } as Draft;
    const post = { ...input(), userId: 'cache_user', text: 'Rain on the bakery window, first loaves out.' };
    const a = await planVideo(post, input(), { draft });
    const b = await planVideo({ ...post, text: `  ${post.text}  `, overrides: { format: 'motion_graphic' } }, input({ balance: 22 }), { draft });
    expect(calls).toBe(1);
    expect(a.plan.format).toBe('ai_video');
    expect(b).toMatchObject({ plan: { format: 'motion_graphic' }, affordable: false });
    await planVideo({ ...post, userId: 'other_user' }, input(), { draft });
    expect(calls).toBe(2);
    // A failed draft isn't cached.
    const failing = () => { calls++; return Promise.resolve(null); };
    await planVideo({ ...post, userId: 'fail_user' }, input(), { draft: failing });
    await new Promise((r) => setTimeout(r, 0));
    await planVideo({ ...post, userId: 'fail_user' }, input(), { draft: failing });
    expect(calls).toBe(4);
  });

  it('no LLM configured → the heuristic plans it', async () => {
    const r = await planVideo(input(), input());
    expect(r.plan.format).toBe('ai_video');
    expect(r.summary).toMatch(/bakery/); // describes the video, not the spec
    expect(r.summary).not.toMatch(/credits|\d+ s\b|9:16/);
    expect(r.estimatedCredits).toBe(r.plan.estimatedCredits);
  });
  it('unparseable LLM output → heuristic; valid output → used', async () => {
    st.ai = { kind: 'openai' };
    st.reply = 'not json';
    expect((await planVideo(input(), input())).plan.format).toBe('ai_video');
    st.reply = JSON.stringify({ format: 'motion_graphic', graphicsEngine: 'ai_motion', durationSec: 10, confidence: 0.9 });
    expect((await planVideo(input(), input())).plan).toMatchObject({ format: 'motion_graphic', durationSec: 10 });
  });
});

// The five posts from the 2026-10-17 live run (/tmp/sociafy-live/v13.log), with the drafts the model gave.
const V13 = {
  q3: 'Q3 numbers are in: revenue up 42%, churn down to 1.8%, and 12,000 new users. Thank you to everyone who made it happen.',
  roastery: 'Behind the scenes at our roastery this morning: beans tumbling out of the drum, steam rising, our head roaster checking the color by hand.',
  launch: 'Launch day! Order ahead in our app, walk in, and your coffee is waiting. First order is ₹99 this week only.',
  hotTake: "Hot take: most startups don't have a marketing problem, they have a clarity problem. Say what you do in 7 words.",
  celeb: 'Elon Musk just tried our new espresso machine and loved it.',
};
const ALL4 = ['linkedin', 'facebook', 'youtube', 'instagram'];
const v13 = (text: string, over: Partial<BrainInput> = {}) => input({ text, platforms: ALL4, ...over });
const launchDraft = draft({
  format: 'hybrid', recipe: 'H1', graphicsEngine: 'ai_motion', footageEngine: 'motion-1-fast', footageSeconds: 6, durationSec: 12, aspect: '9:16',
  footagePrompt: "wide shot of a modern coffee shop counter, barista's hands placing a steaming cup on a tray, soft side lighting",
  audio: { music: 'upbeat', sfx: 'ambient cafe' } as never, onScreenText: ['Launch Day!', 'Order ahead in app', 'First order ₹99', 'Walk‑in pickup'],
});
const celebDraft = draft({ format: 'motion_graphic', graphicsEngine: 'ai_motion', durationSec: 6, aspect: '16:9', videoAllowed: false, audio: { narration: false, music: false, sfx: false }, onScreenText: [], signals: ['S11', 'S12', 'S8'] });
const hotTakeDraft = draft({
  format: 'motion_graphic', graphicsEngine: 'ai_motion', durationSec: 10, aspect: '16:9', audio: { sfx: true },
  onScreenText: ['Hot take: most startups don’t have a marketing problem, they have a clarity problem.', 'Say what you do in 7 words.'],
});

describe('signals fire only when true (v13 posts)', () => {
  it('coffee launch: "our app" is not a UI post; ₹99 is a must-show number', () => {
    const s = detectSignals(V13.launch, []);
    expect(s).toMatchObject({ S7: false, S1: true, S8: true });
    expect(finalizePlan(launchDraft, v13(V13.launch)).reasons.join(' ')).not.toMatch(/Screens and UI/);
  });
  it('hot take: "7 words" is not a number that must stay legible', () => {
    expect(detectSignals(V13.hotTake, [])).toMatchObject({ S1: false, S4: true });
    expect(finalizePlan(hotTakeDraft, v13(V13.hotTake)).reasons.join(' ')).not.toMatch(/Numbers, prices or dates/);
  });
  it('celebrity post: no offer or announcement; the policy reason instead', () => {
    expect(detectSignals(V13.celeb, []).S8).toBe(false);
    const r = finalizePlan(celebDraft, v13(V13.celeb)).reasons;
    expect(r.join(' ')).not.toMatch(/offer|call to action|announcement/i);
    expect(r).toContain('Real people, children and other brands are never generated as AI video.');
  });
  it('Q3: "new users" is not an announcement; stats are', () => {
    expect(detectSignals(V13.q3, [])).toMatchObject({ S8: false, S1: true, S2: true });
  });
  it('type reasons need graphics: an AI video never claims numbers are set as type', () => {
    const p = finalizePlan(draft({ format: 'ai_video' }), v13(V13.roastery));
    expect(p.reasons.join(' ')).not.toMatch(/set as (real )?type/);
  });
});

describe('summary and reasons copy', () => {
  it('copyLine: ≤ max, no vendor, no spec or credits', () => {
    expect(copyLine("Coffee waiting at the counter, then '₹99 first order' and 'Order ahead' animate on top.", 120)).toBeTruthy();
    for (const bad of ['Made with Seedance footage.', 'A 12 s vertical reel.', 'Costs 373 credits.', 'Shot in 9:16.', 'x'.repeat(121), 42, '']) {
      expect(copyLine(bad, 120)).toBeNull();
    }
  });
  it('the model’s summary and reasons are used when valid and the plan kept its shape', () => {
    const d = { ...launchDraft, summary: "Coffee waiting at the counter, then '₹99 first order' and 'Order ahead' animate on top.", reasons: ['The counter scene sells walk-in pickup.', 'The ₹99 offer must be readable, so it is set as type.'] };
    const p = finalizePlan(d, v13(V13.launch, { platforms: ['instagram'] }));
    expect(p.format).toBe('hybrid');
    expect(p.summary).toBe(d.summary);
    expect(p.reasons).toEqual(d.reasons);
  });
  it('invalid model copy → code copy about the post; an override format never keeps the model’s summary', () => {
    const d = { ...launchDraft, summary: 'Hybrid, 12 s, 9:16, 373 credits', reasons: ['Only one reason.'] };
    const p = finalizePlan(d, v13(V13.launch, { platforms: ['instagram'] }));
    expect(p.summary).toMatch(/coffee shop counter.*“Launch Day!”/);
    expect(p.summary).not.toMatch(VENDOR_RX);
    expect(p.summary.length).toBeLessThanOrEqual(120);
    expect(p.reasons.length).toBeGreaterThan(0);
    const good = { ...launchDraft, summary: 'Coffee at the counter, then the offer animates on top.' };
    const mg = finalizePlan(good, v13(V13.launch, { platforms: ['instagram'], overrides: { format: 'motion_graphic' } }));
    expect(mg.summary).not.toBe(good.summary);
    expect(mg.summary).toMatch(/“Launch Day!”/);
  });
  it('every override plan comes back with reasons', () => {
    for (const format of ['ai_video', 'motion_graphic', 'hybrid'] as const) {
      for (const text of Object.values(V13)) {
        const p = finalizePlan(draft({ format: 'hybrid' }), v13(text, { overrides: { format } }));
        expect(p.reasons.length, `${format}: ${text}`).toBeGreaterThan(0);
        expect(p.summary.length).toBeGreaterThan(0);
      }
    }
  });
  it('the approved copy survives revalidation', () => {
    const d = { ...launchDraft, summary: 'Coffee at the counter, then the offer animates on top.', reasons: ['Walk-in pickup reads as a scene.', 'The offer is set as type.'] };
    const p = finalizePlan(d, v13(V13.launch, { platforms: ['instagram'] }));
    const again = finalizePlan(draftFromPlan(p), v13(V13.launch, { platforms: ['instagram'], overrides: { format: p.format as "hybrid" } }), { revalidate: true });
    expect(again).toMatchObject({ summary: p.summary, reasons: p.reasons });
  });
});

describe('alternatives: distinct and named (v13 post 3)', () => {
  const full = v13(V13.launch, { platforms: ['instagram'], balance: 22 });
  it('cheapest + alternatives are distinct by (format, template, footage engine), ≤ 3 chips, labelled', async () => {
    const r = await planVideo(full, full, { draft: () => Promise.resolve(launchDraft) });
    const chips = [r.cheapest!, ...r.alternatives];
    expect(r.cheapest).toMatchObject({ label: 'Logo sting', estimatedCredits: 126 });
    expect(new Set(chips.map((c) => c.key)).size).toBe(chips.length);
    expect(chips.length).toBeLessThanOrEqual(3);
    expect(r.alternatives.map((a) => a.label).sort()).toEqual(['AI video', 'Motion graphic']);
    expect(chips.map((c) => c.key)).not.toContain(r.plan.format + '|ai_motion|motion-1-fast');
  });
  it('each chip re-plans to exactly its option: { cheapest: true } for cheapest, { format } for alternatives', async () => {
    const r = await planVideo(full, full, { draft: () => Promise.resolve(launchDraft) });
    const c = finalizePlan(launchDraft, { ...full, overrides: { cheapest: true } });
    expect(c).toMatchObject({ graphics: { engine: 'template', template: 'sting' }, estimatedCredits: r.cheapest!.estimatedCredits });
    // …and generate-auto's revalidation keeps it (the ₹ font gate doesn't apply to the sting).
    expect(finalizePlan(draftFromPlan(c), { ...full, overrides: { format: 'motion_graphic' } }, { revalidate: true }).estimatedCredits).toBe(c.estimatedCredits);
    for (const a of r.alternatives) {
      const p = finalizePlan(launchDraft, { ...full, overrides: { format: a.format as 'hybrid' } });
      expect([p.estimatedCredits, p.format]).toEqual([a.estimatedCredits, a.format]);
    }
    // A Cinema cheapest (engine differs, label the same) is reachable too.
    const d = draft({ format: 'ai_video', footageEngine: 'motion-1-fast', durationSec: 8 });
    const roast = v13(V13.roastery, { platforms: ['instagram'], balance: 22 });
    expect(finalizePlan(d, roast).cheapest?.key).toBe('ai_video||cinema-1');
    expect(finalizePlan(d, { ...roast, overrides: { cheapest: true } }).footage?.engine).toBe('cinema-1');
  });
  it('an alternative equal to cheapest is shown once (as cheapest)', () => {
    const d = draft({ format: 'ai_video', graphicsEngine: 'template', template: 'sting' });
    const inp = v13(V13.roastery, { platforms: ['instagram'], balance: 22 });
    const p = finalizePlan(d, inp);
    expect(p.cheapest?.key).toBe('motion_graphic|sting|');
    expect(alternativesFor(p, inp, d).map((a) => a.key)).not.toContain('motion_graphic|sting|');
  });
  it('a cheapest that is the plan itself is dropped', async () => {
    const inp = v13(V13.celeb, { balance: 22, availability: { ...ALL, templates: false } });
    const r = await planVideo(inp, inp, { draft: () => Promise.resolve(celebDraft) });
    expect(r.plan.cheapest).toBeUndefined();
    expect(r.cheapest).toBeUndefined();
  });
});

describe('thin plans get real content (v13 posts 4 and 5)', () => {
  it('celebrity post: kinetic type of the message, ≥ 8 s, 2–4 lines, SFX on, no footage', () => {
    const p = finalizePlan(celebDraft, v13(V13.celeb));
    expect(p).toMatchObject({ format: 'motion_graphic', footage: null, graphics: { engine: 'ai_motion' } });
    expect(p.durationSec).toBeGreaterThanOrEqual(8);
    expect(p.audio.sfx).toBe(true);
    expect(p.onScreenText.length).toBeGreaterThanOrEqual(2);
    expect(p.onScreenText.length).toBeLessThanOrEqual(4);
    expect(p.onScreenText.join(' ')).toMatch(/espresso machine/);
    // The user's own words only, even if the model paraphrased.
    const para = finalizePlan({ ...celebDraft, onScreenText: ['Elon Musk tried our espresso', 'He loved the rich, smooth brew'] }, v13(V13.celeb));
    expect(para.onScreenText.join(' ')).not.toMatch(/smooth brew/);
    expect(para.summary).toMatch(/“Elon Musk just tried our new espresso machine and loved it”/);
    expect(para.reasons.length).toBeGreaterThanOrEqual(2);
  });
  it('long model lines are split into short ones', () => {
    const p = finalizePlan(hotTakeDraft, v13(V13.hotTake));
    expect(p.onScreenText.length).toBeGreaterThanOrEqual(2);
    expect(p.onScreenText.length).toBeLessThanOrEqual(4);
    for (const l of p.onScreenText) expect(l.length).toBeLessThanOrEqual(48);
  });
  it('only the logo sting may run under 8 s', () => {
    expect(finalizePlan(draft({ format: 'motion_graphic', graphicsEngine: 'template', template: 'sting' }), input({ text: V13.hotTake })).durationSec).toBe(7);
    expect(finalizePlan(draft({ format: 'motion_graphic', durationSec: 6 }), input({ text: V13.hotTake, overrides: { durationSec: 6 } })).durationSec).toBe(8);
  });
  it('toLines: clause breaks, word-wrapped, no URLs or hashtags', () => {
    expect(toLines(['Q3 numbers are in: revenue up 42%, churn down to 1.8%. #growth https://x.co'])).toEqual(['Q3 numbers are in', 'revenue up 42%, churn down to 1.8%']);
    expect(toLines(['Hot take: most startups don’t have a marketing problem, they have a clarity problem.'])).toEqual(['Hot take', 'most startups don’t have a marketing problem', 'they have a clarity problem']);
  });
  it('music: "upbeat" from the model reads as music on', () => {
    expect(finalizePlan(launchDraft, v13(V13.launch, { platforms: ['instagram'] })).audio).toMatchObject({ music: true, sfx: true });
  });
});

describe('override views (v14 post 3)', () => {
  // The live draft: the model picked a motion graphic and wrote no footage prompt.
  const v14Draft = draft({
    format: 'motion_graphic', graphicsEngine: 'ai_motion', aspect: '16:9', confidence: 0.97, durationSec: 10, audio: { narration: false, music: false, sfx: true },
    onScreenText: ['Launch day!', 'Order ahead in app', 'First order ₹99 this week only'],
    reasons: ['Numbers, prices or dates must stay legible.', 'The announcement is set as bold type.'],
  });
  const post = (over: Partial<BrainInput> = {}) => input({ text: V13.launch, platforms: ['linkedin', 'facebook'], balance: 22, ...over });
  const plan = (overrides?: BrainInput['overrides'], d: Draft = v14Draft) => planVideo(post({ overrides }), post(), { draft: () => Promise.resolve(d) });
  const BEST_FIT_CLAIM = /best (?:fit|shown)|works best|suits|carries it|so footage/i;

  it('cheapest is the post-wide cheapest in every view, never a same-label chip', async () => {
    const best = await plan();
    expect(best.cheapest).toMatchObject({ label: 'Logo sting', estimatedCredits: 126 });
    const ai = await plan({ format: 'ai_video' });
    expect(ai.plan.format).toBe('ai_video');
    expect(ai.cheapest).toMatchObject({ label: 'Logo sting', estimatedCredits: 126 });
    expect(ai.cheapest?.label).not.toBe('AI video');
    // On the cheapest card itself there is no cheaper chip.
    expect((await plan({ cheapest: true })).cheapest).toBeUndefined();
  });

  it('picked AI video: honest tradeoff reasons, grounded in the post', async () => {
    const { plan: p, reasons } = await plan({ format: 'ai_video' });
    // Live prices: AI video 181 vs the best fit's 180, so no "Cheaper".
    expect([p.estimatedCredits, (await plan()).estimatedCredits]).toEqual([181, 180]);
    expect(reasons).toEqual([
      "The ₹99 offer won't appear as readable text.",
      'Footage only — add the offer in your caption.',
      'Our pick for this post: Motion graphic.',
    ]);
    expect(p.reasons).toEqual(reasons);
    for (const r of reasons) expect(r).not.toMatch(BEST_FIT_CLAIM);
    // Every line survives generate-auto's revalidation.
    for (const r of reasons) expect(copyLine(r, 90)).toBe(r);
  });

  it('picked cheapest / hybrid / motion graphic: what each gives up or adds', async () => {
    const longer = { ...v14Draft, durationSec: 12, audio: { music: true, sfx: true } };
    expect((await plan({ format: 'ai_video' }, longer)).reasons[0]).toBe("Cheaper, but the ₹99 offer won't appear as readable text.");
    expect((await plan({ cheapest: true })).reasons[0]).toBe("Just your logo and tagline — the post's message isn't shown.");
    expect((await plan({ format: 'hybrid' })).reasons[0]).toBe('Adds AI footage of the scene behind your text.');
    const roast = input({ text: V13.roastery, platforms: ['instagram'], balance: 22, overrides: { format: 'motion_graphic' } });
    const r = await planVideo(roast, roast, { draft: () => Promise.resolve(draft({ format: 'ai_video', footagePrompt: 'Beans tumble from a roasting drum, steam rising' })) });
    expect(r.reasons[0]).toMatch(/^(?:Cheaper, but no|No) AI footage — the scene in your post isn't shown\.$/);
    expect(r.reasons.at(-1)).toBe('Our pick for this post: AI video.');
  });

  it('AI video summary describes the scene (≥ 6 words); the prompt starts with it, no dangling clause', async () => {
    const { plan: p, summary } = await plan({ format: 'ai_video' });
    const prompt = p.footage!.prompt;
    expect(prompt.startsWith('Walk in, and your coffee is waiting.')).toBe(true);
    expect(prompt).not.toMatch(/Cinematic footage that shows|First order|this week only|Launch day|app/);
    expect(summary.split(/\s+/).length).toBeGreaterThanOrEqual(6);
    expect(summary).toMatch(/coffee is waiting/);
    // With the model's scene prompt, the summary is that scene.
    const withScene = await plan({ format: 'ai_video' }, { ...v14Draft, footagePrompt: 'Wide shot of a barista sliding a steaming cup across the counter, soft morning light' });
    expect(withScene.summary).toBe('Wide shot of a barista sliding a steaming cup across the counter, soft morning light.');
  });

  it('sceneProse drops must-read clauses whole', () => {
    expect(sceneProse(V13.launch, true)).toBe('Walk in, and your coffee is waiting.');
    expect(sceneProse('Hands pour latte art, steam rising, sign reads "₹99". Morning light fills the cafe.', false)).toBe('Hands pour latte art, steam rising. Morning light fills the cafe.');
  });

  it('never "real footage": model copy is rewritten, templates never say it', async () => {
    expect(copyLine('The post describes a vivid scene, best shown with real footage', 90)).toBe('The post describes a vivid scene, best shown with AI footage');
    expect(copyLine('We must avoid actual footage of a real person', 90)).toBe('We must avoid AI footage of a real person');
    for (const text of Object.values(V13)) {
      for (const overrides of [undefined, { format: 'ai_video' as const }, { format: 'hybrid' as const }, { cheapest: true }]) {
        const r = await planVideo(input({ text, overrides }), input({ text }), { draft: () => Promise.resolve(null) });
        expect([r.summary, ...r.reasons].join(' ')).not.toMatch(/real footage|actual footage/i);
      }
    }
  });
});
