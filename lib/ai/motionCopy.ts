import { completeText, getTextAI } from './client';
import type { MotionTemplate } from './models';
import { ON_SCREEN_TEXT_RULE, stripEmDashes } from './voice-rules';

/**
 * Copy for a motion-graphics template: a hook, short lines, and which of the
 * brand kit's APPROVED facts to show. The model picks facts by index, so a
 * stat it invents has nowhere to go — `coerceMotionCopy` only ever copies
 * kit.facts[i] verbatim.
 */
export type MotionCopy = { hook: string; lines: string[]; facts: string[] };

export type MotionCopyInput = {
  template: MotionTemplate;
  topic: string;
  brandName: string;
  tagline?: string;
  /** brand_kits.kit.facts — the only claims a template may show. */
  facts: string[];
  /** Brand voice (kit.voice.tone), optional. */
  tone?: string[];
};

const LIMITS = { hook: 70, line: 48, lines: { stat: 1, showcase: 4, sting: 0 }, facts: 3 } as const;

export function buildMotionCopyPrompt(i: MotionCopyInput): { system: string; user: string } {
  const lineSpec =
    i.template === 'stat'
      ? '"lines": [one short kicker line shown before the end card, ≤ 8 words]'
      : '"lines": [2–4 captions, 2–3 words each, one per product screenshot]';
  const system = [
    `You write on-screen copy for a ${i.template === 'stat' ? 'stat' : 'product showcase'} motion graphic for ${i.brandName || 'a brand'}.`,
    `Return JSON only: {"hook": string, ${lineSpec}, "factIndexes": number[]}.`,
    `"hook": the opening line, ≤ ${LIMITS.hook} characters. Wrap the one word to highlight in *asterisks*.`,
    '"factIndexes": up to 3 indexes into the APPROVED FACTS list, most relevant first. [] if none fit or the list is empty.',
    'NEVER write a number, statistic, percentage, price or claim anywhere that is not in APPROVED FACTS. No hashtags, no emoji.',
    ON_SCREEN_TEXT_RULE,
  ].join('\n');
  const user = [
    `TOPIC: ${i.topic.trim().slice(0, 1_200)}`,
    i.tagline ? `TAGLINE: ${i.tagline}` : '',
    i.tone?.length ? `TONE: ${i.tone.join(', ')}` : '',
    'APPROVED FACTS:',
    ...(i.facts.length ? i.facts.map((f, n) => `${n}. ${f}`) : ['(none)']),
  ].filter(Boolean).join('\n');
  return { system, user };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const DIGIT = /\d/;

/** Model output (string or parsed) → safe copy. Anything invalid falls back. */
export function coerceMotionCopy(raw: unknown, i: MotionCopyInput): MotionCopy {
  let o: Record<string, unknown> = {};
  try {
    o = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    if (!o || typeof o !== 'object') o = {};
  } catch { /* fall back below */ }

  const str = (v: unknown) => (typeof v === 'string' ? stripEmDashes(v.replace(/\s+/g, ' ').trim()) : '');
  // A digit in free text is an unapproved stat — drop the line rather than show it.
  const safe = (s: string) => (DIGIT.test(s) ? '' : s);

  const hook = clip(safe(str(o.hook)), LIMITS.hook) || fallbackHook(i.topic);
  const lines = (Array.isArray(o.lines) ? o.lines : [])
    .map((l) => clip(safe(str(l)), LIMITS.line))
    .filter(Boolean)
    .slice(0, LIMITS.lines[i.template]);
  const idx = Array.isArray(o.factIndexes) ? o.factIndexes : [];
  const picked = [...new Set(idx.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < i.facts.length))]
    .map((n) => i.facts[n]);
  const facts = (picked.length ? picked : i.facts).slice(0, LIMITS.facts);
  return { hook, lines, facts };
}

function fallbackHook(topic: string): string {
  const first = topic.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? '';
  return clip(DIGIT.test(first) ? '' : first, LIMITS.hook);
}

/** One cheap model call. No AI configured / sting / any failure → deterministic fallback. */
export async function writeMotionCopy(i: MotionCopyInput): Promise<MotionCopy> {
  if (i.template === 'sting') return { hook: '', lines: [], facts: [] };
  const ai = getTextAI('fast');
  if (!ai) return coerceMotionCopy({}, i);
  try {
    const p = buildMotionCopyPrompt(i);
    return coerceMotionCopy(await completeText(ai, { ...p, maxOutputTokens: 600, json: true, timeoutMs: 30_000 }), i);
  } catch (e) {
    console.warn('[motion-copy] falling back:', e instanceof Error ? e.message : e);
    return coerceMotionCopy({}, i);
  }
}
