/**
 * Client for the motion-graphics render engine (modal/motion_engine.py).
 *
 * Same contract as lib/ai/modal.ts: every request carries `X-Engine-Secret`,
 * long work is spawn → poll. White-label: nothing from here (engine names,
 * error text) may reach a response body — the finaliser collapses failures via
 * publicVideoError.
 *
 * The feature flag IS the config: with MOTION_ENGINE_URL unset, motion
 * graphics are hidden everywhere and nothing here is called.
 */

import type { MotionTemplate } from './models';

export function motionConfigured(): boolean {
  return Boolean(process.env.MOTION_ENGINE_URL && process.env.MODAL_WEBHOOK_SECRET);
}

async function call<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs?: number }): Promise<T> {
  const root = process.env.MOTION_ENGINE_URL;
  const secret = process.env.MODAL_WEBHOOK_SECRET;
  if (!root || !secret) throw new Error('motion_not_configured');
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
  if (!res.ok) throw new Error(`motion_${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export type SubmitMotionArgs = {
  template: MotionTemplate;
  aspect: '9:16' | '16:9';
  /** Template variables (motion/README.md). */
  vars: Record<string, unknown>;
  /** R2 keys the engine uploads to — ours, so the asset lands in the user's prefix. */
  videoKey: string;
  posterKey: string;
};

export function submitMotion(args: SubmitMotionArgs): Promise<{ callId: string }> {
  return call('motion/submit', { method: 'POST', body: args });
}

export type MotionResult = {
  status: 'pending' | 'done' | 'failed';
  /** Echo of the submitted keys once uploaded. */
  videoKey?: string;
  posterKey?: string;
  videoUrl?: string;
  posterUrl?: string;
  sizeBytes?: number;
  error?: string;
};

export function getMotionResult(callId: string): Promise<MotionResult> {
  return call(`motion/result?callId=${encodeURIComponent(callId)}`, { method: 'GET', timeoutMs: 15_000 });
}
