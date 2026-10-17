/**
 * The video brain: for one post, choose AI video, a motion graphic, or a hybrid
 * (AI footage inside a motion graphic). Rulebook: docs/video-brain.md.
 *
 * Shape: one cheap LLM call proposes a draft, then a DETERMINISTIC post-pass
 * (finalizePlan) owns everything that touches money or policy — engine
 * availability, the real-person gate, every envelope, the price (never the
 * model's number), the cost ceiling + downgrade ladder, and the safe default.
 * With no LLM (or unparseable output) a regex heuristic writes the draft, so
 * planning always works.
 *
 * White-label: `summary`, `reasons` and every plan field use public names
 * ("Sociafy Motion 1", "motion graphic", "AI footage"). Engine ids are ours
 * ('motion-1' | 'motion-1-fast' | 'cinema-1'), never a vendor's.
 */

import { completeText, getGroq, getTextAI, GROQ_MODELS, type TextAI } from './client';
import { MOTION_AI, MOTION_TEMPLATES, VIDEO_MODELS, type MotionTemplate } from './models';
import { priceForMotion, priceForMotionAi, priceForVideo, type VideoQuality } from '../credits/pricing';

// ---------------------------------------------------------------- types

export type PlanFormat = 'ai_video' | 'motion_graphic' | 'hybrid' | 'none';
export type PlanAspect = '9:16' | '1:1' | '16:9';
/** Public engine ids. motion-1 = Sociafy Motion 1 (quality), -fast its Fast tier, cinema-1 = Sociafy Cinema 1. */
export type FootageEngine = 'motion-1' | 'motion-1-fast' | 'cinema-1';
export type FootageMode = 'text' | 'image-to-video' | 'reference';
/** H6 (brand end card on plain AI video) is not implemented: ai_video is footage only. */
export type Recipe = 'H1' | 'H2' | 'H3' | 'H4' | 'H5';
export type PlanAudio = { narration: boolean; music: boolean; sfx: boolean };

export type Plan = {
  format: PlanFormat;
  recipe: Recipe | null;
  graphics: { engine: 'ai_motion' | 'template'; template: MotionTemplate | null } | null;
  footage: { engine: FootageEngine; mode: FootageMode; seconds: number; quality: VideoQuality; prompt: string } | null;
  durationSec: number;
  aspect: PlanAspect;
  audio: PlanAudio;
  onScreenText: string[];
  estimatedCredits: number;
  confidence: number;
  signals: string[];
  reasons: string[];
  /** What runs if the footage of a hybrid fails (refund of the difference + this). Null for other formats. */
  fallback: { format: 'motion_graphic'; estimatedCredits: number } | null;
  /** Set when format is 'none' (nothing can run for this account). */
  reason?: 'unavailable';
  /** False when the balance can't cover this plan. The plan is still the best fit, priced; generate-auto refuses it. */
  affordable?: boolean;
  /** Set when not affordable: the cheapest option the downgrade ladder reaches from this plan. */
  cheapest?: PlanOption;
};

export type PlanOption = { format: PlanFormat; estimatedCredits: number; summary: string };

export type Availability = {
  /** Sociafy Motion 1 (PiAPI key set). */
  motion1: boolean;
  /** Sociafy Cinema 1. */
  cinema: boolean;
  /** Template engine configured AND brand kit motionReady. */
  templates: boolean;
  /** AI motion worker configured AND brand kit motionAiReady. */
  aiMotion: boolean;
  /** Brand-kit screenshots (the showcase template needs ≥2). */
  kitScreenshots?: number;
};

export type Attachment = { url: string; mimeType: string };
export type Overrides = { format?: 'ai_video' | 'motion_graphic' | 'hybrid'; durationSec?: number; aspect?: PlanAspect };

export type BrainInput = {
  text: string;
  platforms: string[];
  attachments: Attachment[];
  availability: Availability;
  balance: number;
  overrides?: Overrides;
  /** Minutes until publish. Unknown → DEFAULT_DEADLINE_MIN. */
  deadlineMin?: number;
};

/** What the LLM (or the heuristic) proposes. Everything is advisory. */
export type Draft = {
  format?: string;
  recipe?: string | null;
  template?: string | null;
  graphicsEngine?: string;
  footageEngine?: string;
  footageMode?: string;
  footageSeconds?: number;
  footageQuality?: string;
  footagePrompt?: string;
  /** The footage may show faces (no identifiable real person). Default false. */
  allowFaces?: boolean;
  videoAllowed?: boolean;
  durationSec?: number;
  aspect?: string;
  audio?: Partial<PlanAudio>;
  onScreenText?: string[];
  confidence?: number;
  signals?: string[];
};

// ---------------------------------------------------------------- constants

const DEFAULT_DEADLINE_MIN = 30;
const SAFE_DEFAULT_SEC = 12;
const FOOTAGE_SEC = { min: 4, max: 8 } as const;
const MIN_CONFIDENCE = 0.6;

/** Appended to every footage prompt. Diffusion garbles words, screens and logos (rulebook §0, §3). */
export const FOOTAGE_NEGATIVE =
  'Physical scene and action only. No on-screen text, no letters or numbers, no signage, no screens, no UI, no holograms, no captions, no logos or brand marks.';
const NO_FACES = 'No identifiable faces: hands, silhouettes, back views or wide shots only.';

/** Words that must never reach a customer. Tests assert summaries/reasons stay clean. */
export const VENDOR_RX = /seedance|piapi|bytedance|minimax|\bh3\b|claude|anthropic|elevenlabs|openai|gpt|hyperframes|\bcue\b/i;

const VERTICAL = new Set(['instagram', 'tiktok', 'facebook']);
const FEED = new Set(['linkedin', 'x', 'reddit']);

/**
 * Pinned Cinema estimate (credits) at 720p, from the backend's published curve
 * ($0.11 / $0.29 / $0.81 / $2.56 for 4 / 8 / 15 / 30 s → ×CREDITS_PER_PROVIDER_USD).
 * The real charge is submitVideo's live quote; generate-auto checks that quote
 * against the approved price first, so this is a display figure, not a bill.
 */
const CINEMA_CREDITS: [number, number][] = [[4, 13], [8, 33], [15, 92], [30, 288]];
/** Cinema render seconds at 720p (rulebook §0): the deadline gate. */
const CINEMA_RENDER_S: [number, number][] = [[4, 134], [8, 345], [15, 965], [30, 3046]];

const interp = (table: [number, number][], x: number) => {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    const [x0, y0] = table[i - 1];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return table[table.length - 1][1];
};

export const cinemaEstimate = (sec: number) => Math.ceil(interp(CINEMA_CREDITS, sec));
const cinemaFits = (sec: number, deadlineMin: number) => 3 * interp(CINEMA_RENDER_S, sec) <= deadlineMin * 60;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

// ---------------------------------------------------------------- pricing

/** Credits for footage alone. Cinema = pinned estimate (see CINEMA_CREDITS). */
export function priceForFootage(f: NonNullable<Plan['footage']>): number {
  if (f.engine === 'cinema-1') return cinemaEstimate(f.seconds);
  return priceForVideo({ durationSec: f.seconds, quality: f.quality, fast: f.engine === 'motion-1-fast' }).credits;
}

/** Credits for the graphics layer alone. */
export function priceForGraphics(p: Pick<Plan, 'graphics' | 'durationSec' | 'audio'>): number {
  if (!p.graphics) return 0;
  if (p.graphics.engine === 'template' && p.graphics.template) return priceForMotion(MOTION_TEMPLATES[p.graphics.template].durationSec).credits;
  return priceForMotionAi(p.durationSec, p.audio).credits;
}

/** Footage s × engine rate + graphics (rulebook §4 step 8). Pure. */
export function priceForPlan(p: Pick<Plan, 'format' | 'footage' | 'graphics' | 'durationSec' | 'audio'>): number {
  switch (p.format) {
    case 'ai_video': return p.footage ? priceForFootage(p.footage) : 0;
    case 'motion_graphic': return priceForGraphics(p);
    case 'hybrid': return (p.footage ? priceForFootage(p.footage) : 0) + priceForGraphics(p);
    default: return 0;
  }
}

// ---------------------------------------------------------------- heuristic signals

const RX = {
  numbers: /\d|%|₹|\$|€|£|https?:\/\/|www\./i,
  stats: /\d+(?:\.\d+)?\s*(?:%|x\b|×)|\bfrom\b.{1,40}\bto\b.{0,20}\d/i,
  list: /\b\d+\s+(?:ways|tips|mistakes|steps|reasons|things|lessons|ideas|rules|habits)\b/i,
  listLines: /^\s*(?:\d+[.)]|[-•*])\s+\S/gm,
  opinion: /hot take|unpopular opinion|\bi (?:think|believe)\b|\bmost (?:founders|people|brands)\b|["“][^"”]{12,}["”]/i,
  scene: /\b(?:kitchen|bakery|caf[eé]|coffee|street|beach|mountain|city|warehouse|factory|workshop|studio|field|forest|sunset|sunrise|dawn|morning|rain|ocean|sea|road|market|shop|store|restaurant|gym|farm|garden|courier|delivery|truck|flour|butter|bottle|cooking|plating|running|walking|pouring|brewing|packing|baking|dancing|driving|riding|crafting|painting|surfing|hiking|cycling|harvest\w*)\b/gi,
  ui: /\b(?:app|dashboard|feature|ui|screens?|saas|software|integration|release|autopilot|workflow|plugin|api)\b/i,
  announce: /\b(?:launch\w*|introducing|now live|announc\w*|is here|coming soon|webinar|event|join us|new)\b/i,
  mood: /\bfeels? like\b|nostalgi|memor(?:y|ies)|\bstory\b|journey|cinematic|atmosphere|\bvibes?\b/i,
  sound: /\bsound of\b|\bhear\b|\blisten\b|\bambien/i,
  policy: /\b(?:congrat\w*|ceo|co-?founder|founder|celebrit\w*|president|prime minister|minister|politician|kids?|child(?:ren)?|bab(?:y|ies)|toddlers?|teens?|teenagers?|minors?)\b|(?:^|\s)@\w{2,}/i,
  /** A letter (\p{L}) outside the Latin script. Currency, digits, punctuation and emoji don't count. */
  nonLatin: /[^\P{L}\p{Script=Latin}]/u,
  explainer: /\bhow to\b|step[- ]by[- ]step|\bguide\b|explained|tutorial|here'?s how/i,
};

export type Signals = Record<'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S10' | 'S11' | 'S14' | 'S15', boolean> & { sound: boolean };

export function detectSignals(text: string, attachments: Attachment[]): Signals {
  const images = attachments.filter((a) => a.mimeType.startsWith('image/')).length;
  const ui = RX.ui.test(text);
  return {
    S1: RX.numbers.test(text),
    S2: RX.stats.test(text),
    S3: RX.list.test(text) || (text.match(RX.listLines)?.length ?? 0) >= 2,
    S4: RX.opinion.test(text),
    S5: (text.match(RX.scene)?.length ?? 0) >= 1,
    S6: images > 0 && !ui,
    S7: ui && (images > 0 || /\b(?:introducing|feature|dashboard|app)\b/i.test(text)),
    S8: RX.announce.test(text),
    S10: RX.mood.test(text),
    S11: RX.policy.test(text),
    S14: RX.nonLatin.test(text),
    S15: RX.explainer.test(text),
    sound: RX.sound.test(text),
  };
}

/** Footage prompt from the post itself: words only, nothing that must be legible. */
function sceneFromText(text: string): string {
  const clean = text
    .replace(/https?:\/\/\S+|www\.\S+|[#@]\w+/g, ' ')
    .replace(/["“”][^"“”]*["“”]/g, ' ')
    .replace(/[\d₹$€£%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return `Cinematic footage that shows the scene in this post: ${clean}`;
}

/** The regex-only planner. Confidence < MIN_CONFIDENCE when the signals are ambiguous → safe default. */
export function heuristicDraft(input: Pick<BrainInput, 'text' | 'attachments' | 'platforms'>): Draft {
  const s = detectSignals(input.text, input.attachments);
  const textNeed = s.S1 || s.S2 || s.S3 || s.S4 || s.S7 || s.S14;
  const videoAllowed = !s.S11;
  const sceneNeed = videoAllowed && !s.S7 && (s.S5 || s.S6 || s.S10);
  const signals = (Object.keys(s) as (keyof Signals)[]).filter((k) => k !== 'sound' && s[k]);
  const hero = s.S6 && input.attachments.some((a) => a.mimeType.startsWith('image/'));

  const base: Draft = { signals, videoAllowed, confidence: 0.5, footagePrompt: sceneFromText(input.text) };
  if (textNeed && sceneNeed) {
    const recipe = hero ? 'H3' : s.S2 ? 'H2' : 'H1';
    return {
      ...base, format: 'hybrid', recipe, graphicsEngine: 'ai_motion', confidence: 0.65,
      footageEngine: hero ? 'motion-1' : 'motion-1-fast', footageMode: hero ? 'image-to-video' : 'text',
      footageSeconds: recipe === 'H2' ? 8 : recipe === 'H3' ? 5 : 6,
    };
  }
  if (sceneNeed) {
    return {
      ...base, format: 'ai_video', confidence: 0.7,
      footageEngine: s.sound ? 'cinema-1' : hero ? 'motion-1' : 'motion-1-fast',
      footageMode: hero && !s.sound ? 'image-to-video' : 'text',
    };
  }
  if (textNeed) {
    const template = s.S7 ? 'showcase' : s.S2 && !s.S3 && !s.S14 ? 'stat' : null;
    return {
      ...base, format: 'motion_graphic', confidence: 0.7,
      graphicsEngine: template ? 'template' : 'ai_motion', template,
      durationSec: s.S15 ? 15 : undefined,
      audio: { narration: s.S15 },
    };
  }
  return base; // neither side clear → safe default
}

// ---------------------------------------------------------------- post-pass

const primaryAspect = (platforms: string[]): PlanAspect => {
  const p = platforms[0];
  if (!p) return '9:16';
  if (VERTICAL.has(p)) return '9:16';
  if (p === 'youtube') return '16:9';
  return '1:1';
};
const feedOnly = (platforms: string[]) => platforms.length > 0 && platforms.every((p) => FEED.has(p));
const anyVertical = (platforms: string[]) => platforms.some((p) => VERTICAL.has(p) || p === 'youtube');
/** Platform duration window (rulebook §4 step 6). */
const platformWindow = (platforms: string[]) => (feedOnly(platforms) ? { min: 8, def: 10, max: 12 } : { min: 10, def: 12, max: 15 });

const isAspect = (v: unknown): v is PlanAspect => v === '9:16' || v === '1:1' || v === '16:9';
const isTemplate = (v: unknown): v is MotionTemplate => typeof v === 'string' && v in MOTION_TEMPLATES;
const isQuality = (v: unknown): v is VideoQuality => v === '480p' || v === '720p' || v === '1080p';

/** Strip anything that would have to be legible, then append the negative clause. */
export function footagePrompt(raw: string | undefined, text: string, allowFaces: boolean): string {
  const body = (raw?.trim() ? raw : sceneFromText(text))
    .replace(/["“”][^"“”]*["“”]/g, ' ')
    .replace(/[\d₹$€£%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
  return `${body} ${FOOTAGE_NEGATIVE}${allowFaces ? '' : ` ${NO_FACES}`}`;
}

type Ctx = BrainInput & { signals: Signals; revalidate: boolean; notes: string[] };

/** The safe default (rulebook §4 step 10), as a draft for the post-pass. */
const SAFE_DEFAULT: Draft = {
  format: 'motion_graphic', graphicsEngine: 'ai_motion', durationSec: SAFE_DEFAULT_SEC,
  audio: { narration: false, music: false, sfx: true }, confidence: 1,
};

/**
 * Deterministic post-pass. Every money- and policy-relevant field of the result
 * is decided here, whatever the draft said.
 *
 * `revalidate` = the client is sending back a plan the user approved: honor its
 * format as an override and skip the safe default and the downgrade ladder (the
 * user agreed to this price; balance is still enforced by the charge).
 */
export function finalizePlan(draftIn: Draft | null, input: BrainInput, opts: { revalidate?: boolean } = {}): Plan {
  const signals = detectSignals(input.text, input.attachments);
  const ctx: Ctx = { ...input, signals, revalidate: !!opts.revalidate, notes: [] };
  const conf = typeof draftIn?.confidence === 'number' ? draftIn.confidence : 0;
  let draft: Draft = draftIn && (ctx.revalidate || conf >= MIN_CONFIDENCE) ? draftIn : { ...SAFE_DEFAULT, signals: draftIn?.signals };
  if (draft !== draftIn) ctx.notes.push('default');

  const ov = input.overrides ?? {};
  if (ov.format) draft = { ...draft, format: ov.format };
  const av = input.availability;
  const deadline = input.deadlineMin ?? DEFAULT_DEADLINE_MIN;

  // Policy gate (S11): the heuristic regex OR the model can close it; only both can open it.
  const videoAllowed = draft.videoAllowed !== false && !signals.S11 && !RX.policy.test(draft.footagePrompt ?? '');
  const allowFaces = draft.allowFaces === true && videoAllowed;

  // ASPECT
  let aspect: PlanAspect = isAspect(ov.aspect) ? ov.aspect : isAspect(draft.aspect) ? draft.aspect : primaryAspect(input.platforms);

  // FORMAT: availability + policy.
  let format = (['ai_video', 'motion_graphic', 'hybrid'] as const).find((f) => f === draft.format) ?? 'motion_graphic';
  const graphicsAvailable = av.aiMotion || av.templates;
  const footageAvailable = av.motion1 || av.cinema;
  if (!videoAllowed && format !== 'motion_graphic') {
    format = 'motion_graphic';
    ctx.notes.push('policy');
  }
  if (format === 'hybrid' && !(av.motion1 && av.aiMotion)) format = graphicsAvailable || !footageAvailable ? 'motion_graphic' : 'ai_video';
  if (format === 'ai_video' && !footageAvailable) format = 'motion_graphic';
  if (format === 'motion_graphic' && !graphicsAvailable) {
    if (!footageAvailable || !videoAllowed) return none(ctx, aspect);
    format = 'ai_video';
  }

  // AUDIO (step 7): feed-only → SFX only; narration only for explainers, never feed-only.
  const audio: PlanAudio = {
    narration: !!draft.audio?.narration,
    music: draft.audio?.music ?? anyVertical(input.platforms),
    sfx: draft.audio?.sfx ?? true,
  };
  if (feedOnly(input.platforms)) Object.assign(audio, { narration: false, music: false, sfx: true });

  const win = platformWindow(input.platforms);
  const wantSec = ov.durationSec ?? draft.durationSec ?? win.def;
  const onScreenText = (draft.onScreenText ?? []).filter((t) => typeof t === 'string').map((t) => t.slice(0, 120)).slice(0, 6);

  let plan: Plan = {
    format, recipe: null, graphics: null, footage: null, durationSec: wantSec, aspect, audio, onScreenText,
    estimatedCredits: 0, confidence: Math.max(0, Math.min(1, conf)),
    signals: Array.from(new Set([...(draft.signals ?? []).filter((x) => /^S\d{1,2}$/.test(x)), ...activeSignals(signals)])),
    reasons: [], fallback: null,
  };

  const image = input.attachments.find((a) => a.mimeType.startsWith('image/'));
  const footage = (seconds: number, hybrid: boolean): NonNullable<Plan['footage']> => {
    let engine: FootageEngine = draft.footageEngine === 'motion-1' || draft.footageEngine === 'cinema-1' ? draft.footageEngine : 'motion-1-fast';
    // Cinema: sound/mood work only, within its deadline, never inside a hybrid (v1), never with refs.
    if (engine === 'cinema-1' && (hybrid || !av.cinema || !cinemaFits(seconds, deadline) || draft.footageMode === 'reference')) engine = 'motion-1-fast';
    if (engine !== 'cinema-1' && !av.motion1) engine = 'cinema-1';
    let mode: FootageMode = draft.footageMode === 'image-to-video' || draft.footageMode === 'reference' ? draft.footageMode : 'text';
    if (!image || engine === 'cinema-1') mode = 'text';
    let quality: VideoQuality = isQuality(draft.footageQuality) ? draft.footageQuality : '720p';
    if (engine !== 'motion-1' && quality === '1080p') quality = '720p'; // Fast and Cinema top out at 720p
    const m = VIDEO_MODELS[engine === 'cinema-1' ? 'sociafy-cinema-1' : 'sociafy-motion-1'];
    return { engine, mode, quality, seconds: clamp(seconds, m.durationSec.min, m.durationSec.max), prompt: footagePrompt(draft.footagePrompt, input.text, allowFaces) };
  };

  if (format === 'ai_video') {
    plan.footage = footage(wantSec, false);
    plan.durationSec = plan.footage.seconds;
    // Motion 1 is mute; Cinema scores its own sound.
    plan.audio = plan.footage.engine === 'cinema-1' ? { narration: false, music: true, sfx: true } : { narration: false, music: false, sfx: false };
  } else if (format === 'hybrid') {
    plan.durationSec = clamp(wantSec, MOTION_AI.durationSec.min, MOTION_AI.durationSec.max);
    const want = draft.footageSeconds ?? Math.round(plan.durationSec / 2);
    plan.footage = footage(clamp(want, FOOTAGE_SEC.min, Math.min(FOOTAGE_SEC.max, plan.durationSec - 2)), true);
    const recipe = (['H1', 'H2', 'H3', 'H4'] as const).find((r) => r === draft.recipe);
    plan.recipe = plan.footage.mode === 'image-to-video' ? 'H3' : recipe && recipe !== 'H3' ? recipe : 'H1';
    plan.graphics = { engine: 'ai_motion', template: null };
  } else {
    plan.graphics = graphicsFor(draft, ctx, aspect);
    if (plan.graphics.engine === 'template') {
      plan.durationSec = MOTION_TEMPLATES[plan.graphics.template!].durationSec;
      plan.audio = { narration: false, music: false, sfx: false }; // templates ship no audio
    } else {
      plan.durationSec = clamp(wantSec, MOTION_AI.durationSec.min, MOTION_AI.durationSec.max);
    }
  }
  if (plan.graphics?.engine === 'template' && aspect === '1:1') plan.aspect = aspect = feedOnly(input.platforms) ? '16:9' : '9:16';

  plan.estimatedCredits = priceForPlan(plan);
  let cheapest: Plan | null = null;
  if (!ctx.revalidate) {
    // Bottom of the ladder from this plan = the cheapest viable option. If even that is out of reach,
    // keep the best fit as is (priced) so the user sees what we'd make; otherwise walk the ladder.
    cheapest = applyLadder(plan, { ...ctx, balance: 0, notes: [] }, false);
    if (cheapest.estimatedCredits <= input.balance) plan = applyLadder(plan, ctx, !!ov.format);
  }
  plan.affordable = plan.estimatedCredits <= input.balance;
  if (!plan.affordable && cheapest) {
    plan.cheapest = { format: cheapest.format, estimatedCredits: cheapest.estimatedCredits, summary: summaryFor(cheapest) };
  }

  if (plan.format === 'hybrid') {
    plan.fallback = { format: 'motion_graphic', estimatedCredits: priceForMotionAi(plan.durationSec, plan.audio).credits };
  }
  plan.reasons = reasonsFor(plan, ctx);
  return plan;
}

function graphicsFor(draft: Draft, ctx: Ctx, aspect: PlanAspect): NonNullable<Plan['graphics']> {
  const av = ctx.availability;
  const t = isTemplate(draft.template) ? draft.template : null;
  // Templates: Latin only (S14), stat ≤3 facts, showcase needs kit screenshots; 1:1 → AI motion if we can.
  // ₹ isn't S14 (it's not a script) but template fonts still lack the glyph.
  const fits = t && av.templates && !ctx.signals.S14 && !ctx.text.includes('₹') && (t !== 'showcase' || (av.kitScreenshots ?? 0) >= 2) && !(aspect === '1:1' && av.aiMotion);
  if (draft.graphicsEngine === 'template' && fits) return { engine: 'template', template: t };
  if (av.aiMotion) return { engine: 'ai_motion', template: null };
  // AI motion unavailable, templates are: stat is the general-purpose one.
  return { engine: 'template', template: t && fits ? t : 'stat' };
}

const activeSignals = (s: Signals) => (Object.keys(s) as (keyof Signals)[]).filter((k) => k !== 'sound' && s[k]);

/** Only for genuine impossibility (no engine this account can use). Low balance is never 'none'. */
function none(ctx: Ctx, aspect: PlanAspect): Plan {
  return {
    format: 'none', recipe: null, graphics: null, footage: null, durationSec: 0, aspect,
    audio: { narration: false, music: false, sfx: false }, onScreenText: [], estimatedCredits: 0, confidence: 1,
    signals: activeSignals(ctx.signals), fallback: null, reason: 'unavailable',
    reasons: ['Video is not available for this account yet. Add your brand name and main color in Brand kit.'],
  };
}

/**
 * Cost ceiling + downgrade ladder (rulebook §4 step 8):
 * ceiling = min(balance, max(25% of balance, cheapest viable option)).
 * Steps, in order: 1080p→720p, quality→Fast, Fast→Cinema (deadline permitting),
 * shorten to the platform minimum, hybrid/ai_video→motion graphic, drop the
 * audio surcharge, AI motion→sting template. A user-chosen format is never changed.
 */
function applyLadder(start: Plan, ctx: Ctx, formatLocked: boolean): Plan {
  const av = ctx.availability;
  const win = platformWindow(ctx.platforms);
  const cheapest = Math.min(
    av.templates ? priceForMotion(MOTION_TEMPLATES.sting.durationSec).credits : Infinity,
    av.aiMotion ? priceForMotionAi(Math.max(MOTION_AI.durationSec.min, win.min)).credits : Infinity,
    av.motion1 ? priceForVideo({ durationSec: 4, quality: '720p', fast: true }).credits : Infinity,
  );
  const ceiling = Math.min(ctx.balance, Math.max(0.25 * ctx.balance, cheapest));
  const deadline = ctx.deadlineMin ?? DEFAULT_DEADLINE_MIN;

  const steps: ((p: Plan) => Plan | null)[] = [
    (p) => (p.footage?.quality === '1080p' ? { ...p, footage: { ...p.footage, quality: '720p' } } : null),
    (p) => (p.footage?.engine === 'motion-1' ? { ...p, footage: { ...p.footage, engine: 'motion-1-fast', quality: p.footage.quality === '1080p' ? '720p' : p.footage.quality } } : null),
    (p) => (p.format === 'ai_video' && p.footage?.engine === 'motion-1-fast' && p.footage.mode === 'text' && av.cinema && cinemaFits(p.footage.seconds, deadline)
      ? { ...p, footage: { ...p.footage, engine: 'cinema-1', quality: '720p' }, audio: { narration: false, music: true, sfx: true } } : null),
    (p) => {
      if (p.graphics?.engine === 'template') return null;
      const min = p.format === 'ai_video' ? Math.max(4, win.min) : Math.max(MOTION_AI.durationSec.min, win.min);
      if (p.durationSec <= min) return null;
      const footage = p.footage && { ...p.footage, seconds: p.format === 'ai_video' ? min : Math.min(p.footage.seconds, Math.max(FOOTAGE_SEC.min, min - 2)) };
      return { ...p, durationSec: min, footage };
    },
    (p) => ((p.format === 'hybrid' || p.format === 'ai_video') && !formatLocked && av.aiMotion
      ? { ...p, format: 'motion_graphic', recipe: null, footage: null, graphics: { engine: 'ai_motion', template: null }, durationSec: Math.max(MOTION_AI.durationSec.min, p.durationSec), audio: p.format === 'ai_video' ? { narration: false, music: false, sfx: true } : p.audio } : null),
    (p) => (p.graphics?.engine === 'ai_motion' && (p.audio.narration || p.audio.music) ? { ...p, audio: { ...p.audio, narration: false, music: false } } : null),
    (p) => (p.format === 'motion_graphic' && p.graphics?.engine === 'ai_motion' && av.templates
      ? { ...p, graphics: { engine: 'template', template: 'sting' }, durationSec: MOTION_TEMPLATES.sting.durationSec, aspect: p.aspect === '1:1' ? (feedOnly(ctx.platforms) ? '16:9' : '9:16') : p.aspect, audio: { narration: false, music: false, sfx: false } } : null),
  ];

  let plan = start;
  for (const step of steps) {
    if (plan.estimatedCredits <= ceiling) break;
    const next = step(plan);
    if (!next) continue;
    next.estimatedCredits = priceForPlan(next);
    if (next.estimatedCredits < plan.estimatedCredits) {
      plan = next;
      ctx.notes.push('budget');
    }
  }
  return plan;
}

// ---------------------------------------------------------------- customer copy

const ENGINE_NAME: Record<FootageEngine, string> = {
  'motion-1': 'Sociafy Motion 1',
  'motion-1-fast': 'Sociafy Motion 1 Fast',
  'cinema-1': 'Sociafy Cinema 1',
};

const audioLabel = (a: PlanAudio) => {
  const parts = [a.narration && 'voiceover', a.music && 'music', a.sfx && 'sound effects'].filter(Boolean);
  return parts.length ? parts.join(' + ') : 'silent';
};

/** One line, customer-facing, no vendor names. */
export function summaryFor(p: Plan): string {
  if (p.format === 'none') return 'Video is not available yet';
  const tail = `${p.durationSec} s, ${p.aspect}, ${p.estimatedCredits} credits`;
  if (p.format === 'ai_video') {
    const sound = p.footage!.engine === 'cinema-1' ? 'with sound' : 'silent';
    return `AI video on ${ENGINE_NAME[p.footage!.engine]} (${p.footage!.quality}, ${sound}), ${tail}`;
  }
  if (p.format === 'hybrid') return `Motion graphic with ${p.footage!.seconds} s of AI footage (${audioLabel(p.audio)}), ${tail}`;
  if (p.graphics?.engine === 'template') return `Motion graphic (${MOTION_TEMPLATES[p.graphics.template!].label} template), ${tail}`;
  return `Motion graphic (${audioLabel(p.audio)}), ${tail}`;
}

const SIGNAL_REASON: Partial<Record<keyof Signals, string>> = {
  S1: 'Numbers, prices or dates must stay legible, so they are set as real type.',
  S2: 'Stats read best as animated numbers.',
  S3: 'A list works as one beat per item.',
  S4: 'An opinion lands as big kinetic type.',
  S5: 'The post describes a physical scene, so AI footage carries it.',
  S6: 'Your product photo becomes the first frame of the footage.',
  S7: 'Screens and UI stay sharp in a motion graphic; AI video would blur them.',
  S8: 'The offer, date and call to action are set as type.',
  S10: 'A mood or story post suits cinematic footage.',
  S11: 'Real people, children and other brands are never generated as AI video.',
  S14: 'This script needs real fonts, so it is set as type.',
  S15: 'An explainer works best as a motion graphic.',
};

function reasonsFor(p: Plan, ctx: Ctx): string[] {
  const out: string[] = [];
  if (ctx.notes.includes('default')) out.push('A branded motion graphic is the reliable choice for this post.');
  for (const k of activeSignals(ctx.signals)) {
    const r = SIGNAL_REASON[k];
    if (!r) continue;
    // Only reasons that agree with the result.
    if ((k === 'S5' || k === 'S6' || k === 'S10') && !p.footage) continue;
    out.push(r);
  }
  if (p.format === 'hybrid') out.push('AI footage plays inside the motion graphic, with your brand, text and logo on top as real layers.');
  if (feedOnly(ctx.platforms) && p.format !== 'ai_video') out.push('Feed autoplay is muted, so sound effects only.');
  if (ctx.notes.includes('budget')) out.push('Scaled down to fit your credit balance.');
  return Array.from(new Set(out)).slice(0, 5);
}

/** Up to two other options (different format or a cheaper graphic), cheapest first. */
export function alternativesFor(plan: Plan, input: BrainInput, draft: Draft | null): PlanOption[] {
  if (plan.format === 'none') return [];
  const seen = new Set([summaryFor(plan)]);
  const out: PlanOption[] = [];
  for (const format of ['motion_graphic', 'ai_video', 'hybrid'] as const) {
    if (format === plan.format) continue;
    const alt = finalizePlan({ ...(draft ?? {}), confidence: 1 }, { ...input, overrides: { ...input.overrides, format } });
    if (alt.format !== format) continue;
    const summary = summaryFor(alt);
    if (seen.has(summary)) continue;
    seen.add(summary);
    out.push({ format, estimatedCredits: alt.estimatedCredits, summary });
  }
  return out.sort((a, b) => a.estimatedCredits - b.estimatedCredits).slice(0, 2);
}

// ---------------------------------------------------------------- LLM

const SYSTEM = `You plan one short social video for a post. Choose ONE format and reply with JSON only; omit keys that don't apply.

Formats:
- motion_graphic: animated type + brand (exact colors, logo, any language). graphicsEngine "ai_motion" (custom, 6-20 s, any aspect) or "template" ("stat" 15 s for <=3 numbers, "showcase" 16 s for product screenshots, "sting" 7 s logo). Templates: Latin script only, no 1:1.
- ai_video: generated footage, 4-15 s. It CANNOT write words, numbers, logos or UI.
- hybrid: 4-8 s of AI footage inside a motion graphic with type on top. recipe H1 (hook, footage with short caption, end card: announcement + scene), H2 (stat over footage under a color scrim), H3 (product photo image-to-video, then price/spec chips, CTA), H4 (footage in a framed card beside big type, B2B).

Signals: numbers/prices/dates/URLs/CTA/quotes, stats, lists/steps, opinions, non-Latin script, UI/SaaS screenshots → text need (graphics). A concrete physical scene with action and place, a product photo hero, mood/story/sound → scene need (footage). text low+scene low → motion_graphic ai_motion. text high+scene low → motion_graphic. text low+scene high → ai_video. both high → hybrid. Abstract concepts (growth, trust, AI) → motion_graphic, never vague footage.
Policy: an identifiable real person, celebrity, politician, minor/child, or another company's brand → videoAllowed false.
Footage engine: "cinema-1" only when sound/atmosphere is central; "motion-1" when the footage is the unobscured hero (product photo, close-up, 1080p); else "motion-1-fast".
footagePrompt (<=40 words): describe the PHYSICAL scene, subject, action, camera move and light only. Never ask for text, signs, screens, UI, holograms or logos. Prefer hands, silhouettes, back views or wide shots over faces.
Platforms: LinkedIn/X → graphics, 8-12 s, muted (sfx only). Instagram/TikTok/Facebook → 9:16, footage hook, 10-15 s, music on. Narration only for explainers, never LinkedIn-only.

JSON keys: format, recipe (H1-H4 or null), graphicsEngine, template (or null), footageEngine, footageMode ("text"|"image-to-video"), footageSeconds, footageQuality ("720p"|"1080p"), footagePrompt, allowFaces (bool), videoAllowed (bool), durationSec, aspect ("9:16"|"1:1"|"16:9"), audio {narration, music, sfx}, onScreenText (<=6 short strings that must appear), confidence (0-1), signals (e.g. ["S1","S5"]: S1 must-show text, S2 stats, S3 list, S4 opinion, S5 scene, S6 product photo, S7 UI, S8 announcement, S9 abstract, S10 mood, S11 real person/brand, S12 platform, S13 brand strict, S14 non-Latin, S15 explainer).`;

/** The post as the planner sees it. Availability and balance are applied after, by finalizePlan, so the LLM call runs in parallel with those lookups. */
export type PostInput = Omit<BrainInput, 'availability' | 'balance'> & { userId?: string };
type BrainContext = Pick<BrainInput, 'availability' | 'balance'>;

function userMessage(input: PostInput): string {
  const images = input.attachments.filter((a) => a.mimeType.startsWith('image/')).length;
  const videos = input.attachments.filter((a) => a.mimeType.startsWith('video/')).length;
  return [
    `Platforms: ${input.platforms.join(', ') || 'unspecified'}`,
    `Attachments: ${images} image(s), ${videos} video(s)`,
    'Post:',
    input.text.slice(0, 4_000),
  ].join('\n');
}

/**
 * Planner providers, fastest first. Measured 2026-10-17 from the prod box, 3 posts:
 * Groq gpt-oss-120b (low) p50 1.1 s; gpt-5-mini minimal p50 3.3 s; gpt-5-mini low p50 7.3 s.
 * A Groq failure (rate limit, outage) falls through to OpenAI, then to the heuristic.
 */
function planners(): { ai: TextAI; timeoutMs: number }[] {
  const groq = getGroq();
  const openai = getTextAI('fast');
  return [
    ...(groq ? [{ ai: { client: groq, kind: 'groq', model: GROQ_MODELS.planner, supportsTools: false } as TextAI, timeoutMs: 5_000 }] : []),
    ...(openai?.kind === 'openai' ? [{ ai: openai, timeoutMs: 8_000 }] : []),
  ];
}

/** One small JSON call. Null on any failure (no provider, timeout, bad JSON). */
export async function llmDraft(input: PostInput): Promise<Draft | null> {
  for (const { ai, timeoutMs } of planners()) {
    try {
      const raw = await completeText(ai, {
        system: SYSTEM, user: userMessage(input), json: true, timeoutMs, maxRetries: 0,
        // The answer is ~250 tokens; gpt-oss counts its (low) reasoning in the same budget.
        maxOutputTokens: ai.kind === 'groq' ? 900 : 600, reasoningEffort: 'minimal',
      });
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Draft;
    } catch (e) {
      console.warn(`[videoBrain] llm draft failed (${ai.kind}):`, e instanceof Error ? e.message.slice(0, 200) : e);
    }
  }
  return null;
}

// ponytail: per-process LRU; a shared cache (Redis) only if we run more than one app process.
const DRAFT_TTL_MS = 10 * 60_000;
const DRAFT_MAX = 500;
const draftCache = new Map<string, { at: number; draft: Promise<Draft | null> }>();

/**
 * Drafts are cached per (user, post text, platforms, attachments) for 10 min. The draft doesn't
 * depend on overrides, balance or availability (finalizePlan applies those fresh every time), so
 * toggling formats or alternatives re-plans instantly and a top-up shows up at once.
 */
function cachedDraft(input: PostInput, make: (i: PostInput) => Promise<Draft | null>): Promise<Draft | null> {
  if (!input.userId) return make(input);
  const key = JSON.stringify([input.userId, input.text.trim().replace(/\s+/g, ' '), input.platforms, input.attachments.map((a) => [a.url, a.mimeType])]);
  const hit = draftCache.get(key);
  draftCache.delete(key);
  if (hit && Date.now() - hit.at < DRAFT_TTL_MS) {
    draftCache.set(key, hit);
    return hit.draft;
  }
  const entry = { at: Date.now(), draft: make(input) };
  draftCache.set(key, entry);
  if (draftCache.size > DRAFT_MAX) draftCache.delete(draftCache.keys().next().value!);
  // Don't keep failures: the next re-plan should try the model again.
  entry.draft.then((d) => { if (!d && draftCache.get(key) === entry) draftCache.delete(key); }, () => draftCache.delete(key));
  return entry.draft;
}

export type PlanResult = {
  plan: Plan;
  estimatedCredits: number;
  summary: string;
  reasons: string[];
  alternatives: PlanOption[];
  /** False when the balance can't cover the plan; generate-auto will refuse it. */
  affordable: boolean;
  /** Present when not affordable: the cheapest option we could make. */
  cheapest?: PlanOption;
};

/**
 * Plan a video for a post: LLM draft (heuristic if unavailable) → deterministic post-pass.
 * `context` (availability + balance) may be a pending promise: it's awaited alongside the LLM call.
 */
export async function planVideo(
  input: PostInput,
  context: BrainContext | Promise<BrainContext>,
  deps: { draft?: (i: PostInput) => Promise<Draft | null> } = {},
): Promise<PlanResult> {
  const [ctx, llm] = await Promise.all([context, cachedDraft(input, deps.draft ?? llmDraft)]);
  const full: BrainInput = { ...input, ...ctx };
  const draft = llm ?? heuristicDraft(input);
  const plan = finalizePlan(draft, full);
  return {
    plan,
    estimatedCredits: plan.estimatedCredits,
    summary: summaryFor(plan),
    reasons: plan.reasons,
    alternatives: alternativesFor(plan, full, draft),
    affordable: plan.affordable !== false,
    ...(plan.cheapest ? { cheapest: plan.cheapest } : {}),
  };
}

/** A client-sent plan → a Draft the post-pass can re-validate. */
export function draftFromPlan(p: Partial<Plan>): Draft {
  return {
    format: p.format,
    recipe: p.recipe ?? null,
    graphicsEngine: p.graphics?.engine,
    template: p.graphics?.template ?? null,
    footageEngine: p.footage?.engine,
    footageMode: p.footage?.mode,
    footageSeconds: p.footage?.seconds,
    footageQuality: p.footage?.quality,
    footagePrompt: p.footage?.prompt?.replace(FOOTAGE_NEGATIVE, '').replace(NO_FACES, ''),
    // Faces only ever come from the brain's own first pass, never from a client.
    allowFaces: false,
    durationSec: p.durationSec,
    aspect: p.aspect,
    audio: p.audio,
    onScreenText: Array.isArray(p.onScreenText) ? p.onScreenText : [],
    confidence: 1,
    signals: Array.isArray(p.signals) ? p.signals.filter((s): s is string => typeof s === 'string') : [],
  };
}
