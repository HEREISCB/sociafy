/**
 * Client for the AI-designed motion-graphics worker (motion-ai/): a model
 * authors a composition from the post text + brand kit, the worker renders it
 * and uploads to the R2 keys we pass. Same contract as lib/ai/motion.ts —
 * `X-Engine-Secret`, submit → poll — and the same white-label rule: nothing
 * from here (worker names, error text) may reach a response body.
 *
 * The feature flag IS the config: with MOTION_AI_URL or MOTION_AI_SECRET unset,
 * the option is hidden everywhere and nothing here is called.
 */

import type { MotionResult } from './motion';

export function motionAiConfigured(): boolean {
  return Boolean(process.env.MOTION_AI_URL && process.env.MOTION_AI_SECRET);
}

async function call<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs?: number }): Promise<T> {
  const root = process.env.MOTION_AI_URL;
  const secret = process.env.MOTION_AI_SECRET;
  if (!root || !secret) throw new Error('motion_ai_not_configured');
  const res = await fetch(new URL(path, root.endsWith('/') ? root : root + '/'), {
    method: init.method,
    headers: {
      'X-Engine-Secret': secret,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`motion_ai_${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export type MotionAiBrand = {
  brandName?: string;
  tagline?: string;
  cta?: string;
  colors?: { primary: string; secondary: string; background: string; text: string; accent: string };
  logoUrl?: string;
  logoReverseUrl?: string;
  fontDisplayUrl?: string;
  fontBodyUrl?: string;
  style?: 'soft' | 'bold';
};

export type SubmitMotionAiArgs = {
  /** The post text, ≤4000 chars. */
  prompt: string;
  aspect: '9:16' | '16:9' | '1:1';
  /** MOTION_AI.durationSec (6–60). */
  durationSec: number;
  brand: MotionAiBrand;
  /** R2 keys the worker uploads to — ours, so the asset lands in the user's prefix. */
  videoKey: string;
  posterKey: string;
  /** What to mix in. Omitted = silent (the worker defaults every flag off). */
  audio?: MotionAudioRequest;
  /** Hybrid: AI footage clips (https, ≤5) the composition plays. A clip the worker can't fetch fails the job (`footage_failed`). */
  footage?: MotionFootage[];
};

/** One footage clip for a hybrid. Seconds are on the composition's timeline (startSec) and into the clip (trimStartSec). */
export type MotionFootage = { url: string; label?: string; startSec?: number; trimStartSec?: number; durationSec?: number };

/** Narration = voiceover; sfx = sound effects; music = a music bed. `language` is a code ("en", "hi"). */
export type MotionAudioRequest = { narration: boolean; sfx: boolean; music: boolean; voice?: string; language?: string };

/** What the finished MP4 actually carries; `warning` when some or all asked-for audio couldn't be added. */
export type MotionAudio = { narration: boolean; sfx: boolean; music: boolean; warning?: 'audio_unavailable' | 'audio_partial' };

export function submitMotionAi(args: SubmitMotionAiArgs): Promise<{ callId: string }> {
  return call('motion-ai/submit', { method: 'POST', body: args });
}

/** One beat of the composition, as the worker reports it — the edit UI's timeline. */
export type MotionSegment = {
  id: string;
  label: string;
  startSec: number;
  endSec: number;
  onScreenText: string;
  suggestions: string[];
  /** The voiceover line for this beat, when the render has one. */
  narration?: string;
};

/** The template engine's result, plus the composition's segments once done (and the parent for an edit). */
export type MotionAiResult = MotionResult & { segments?: MotionSegment[]; parentCallId?: string; audio?: MotionAudio };

export function getMotionAiResult(callId: string): Promise<MotionAiResult> {
  return call(`motion-ai/result?callId=${encodeURIComponent(callId)}`, { method: 'GET', timeoutMs: 15_000 });
}

export type EditMotionAiArgs = {
  /** callId of the render being edited. */
  parentCallId: string;
  /** Omitted = the whole video. */
  segmentId?: string;
  /** 1–1000 chars. */
  instruction: string;
  videoKey: string;
  posterKey: string;
};

/** Revise a finished render. 404 `parent_not_found` throws like any non-2xx. Polls via getMotionAiResult. */
export function editMotionAi(args: EditMotionAiArgs): Promise<{ callId: string }> {
  return call('motion-ai/edit', { method: 'POST', body: args });
}
