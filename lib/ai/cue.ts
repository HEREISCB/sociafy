/**
 * Client for the render backend behind the Sociafy Cinema model.
 *
 * WHITE-LABEL BOUNDARY. Nothing in here is a public name. The upstream
 * vendor, its host, its status strings and its error text stay on this side of
 * the line — `lib/ai/models.ts` owns what a customer is allowed to see, and
 * `publicVideoError` (app/api/v1/shared.ts) owns what a failure is allowed to
 * say. If you find yourself echoing a field from this file into a response
 * body, that is the bug.
 *
 * Shape: POST a render, poll it, then fetch the file from an authenticated
 * URL — not a public CDN link, so the download carries our bearer token and
 * `finalizeCueJob` is the only thing that ever holds it.
 *
 * Two constraints worth knowing before you change anything here:
 *   - Concurrency is THREE per account, and the account is ours, shared by
 *     every customer. It is not a per-user limit. See `CUE_CONCURRENCY`.
 *   - The vendor charges us the moment a render is queued and refunds us in
 *     full if it fails, which is the same contract we give our own callers.
 */

import { downloadToBuffer } from '../media/finalize';
import { CINEMA_MEGAPIXELS, CINEMA_STEPS, creditsFromProviderUsd } from '../credits/pricing';

const BASE = process.env.CUE_API_BASE || 'https://cue.velinaai.in/v1';

/** Renders queued or running at once, account-wide. A fourth is refused 429. */
export const CUE_CONCURRENCY = 3;

export class CueError extends Error {
  constructor(
    readonly status: number,
    /** Vendor detail. Logs only — never a response body. */
    readonly detail: string,
  ) {
    super(`cue_${status}: ${detail.slice(0, 300)}`);
    this.name = 'CueError';
  }

  /** Our fault, not the caller's: our balance, our budget ceiling, our outage. */
  get isOurs(): boolean {
    return this.status === 401 || this.status === 402 || this.status === 403 || this.status >= 500;
  }
  /** Upstream screening declined the prompt. Nothing was charged upstream. */
  get isRefusal(): boolean {
    return this.status === 422;
  }
  /** All three slots are busy. Retryable, and nothing was charged upstream. */
  get isAtCapacity(): boolean {
    return this.status === 429;
  }
}

function apiKey(): string {
  const k = process.env.CUE_API_KEY;
  if (!k) throw new CueError(401, 'CUE_API_KEY is not set');
  return k;
}

async function call<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${apiKey()}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
  } catch (e) {
    // A transport failure has no HTTP status. 0 means "we never heard back",
    // which the submit path must treat as AMBIGUOUS — the render may be
    // queued and charged upstream even though we saw nothing.
    throw new CueError(0, e instanceof Error ? e.message : String(e));
  }
  const text = await res.text();
  if (!res.ok) throw new CueError(res.status, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CueError(res.status, `unparseable body: ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------- estimate

export type CueEstimate = {
  /** Upstream GPU seconds. Diagnostic only. */
  secs: number;
  /** What the render costs US, in dollars. The only field pricing reads. */
  usd: number;
  frames: number;
  /** Vendor credits. NOT our credits — do not put this in a ledger row. */
  credits: number;
};

/**
 * Price a render without queueing it.
 *
 * We ask rather than model the curve locally. The cost is neither linear in
 * duration nor in area — 4s/8s/15s/30s at full resolution are $0.11/$0.29/
 * $0.81/$2.56, roughly quadratic in frame count — so any local fit drifts the
 * moment the vendor retunes, and drifting downward means selling renders below
 * cost. Asking is free and cannot drift.
 *
 * Memoised because the tuples are few and a cold estimate adds a round-trip to
 * every submit. Unbounded on purpose: the key space is
 * duration × megapixels × steps off a validated enum, so it cannot grow past a
 * few hundred entries.
 */
const estimateCache = new Map<string, CueEstimate>();

export async function cueEstimate(args: {
  durationSec: number;
  megapixels: number;
  steps: number;
}): Promise<CueEstimate> {
  const key = `${args.durationSec}|${args.megapixels}|${args.steps}`;
  const hit = estimateCache.get(key);
  if (hit) return hit;

  const q = new URLSearchParams({
    duration_s: String(args.durationSec),
    megapixels: String(args.megapixels),
    steps: String(args.steps),
  });
  const est = await call<CueEstimate>(`/estimate?${q}`, { timeoutMs: 15_000 });
  if (typeof est?.usd !== 'number' || !(est.usd > 0)) {
    throw new CueError(502, `estimate returned no usable price: ${JSON.stringify(est).slice(0, 200)}`);
  }
  estimateCache.set(key, est);
  return est;
}

// ------------------------------------------------------------------ render

export type CueRenderParams = {
  prompt: string;
  durationSec: number;
  megapixels: number;
  steps: number;
  aspect: string;
  seed?: number;
};

/** Queue a render. Returns as soon as it is queued — and charged upstream. */
export async function createCueRender(args: CueRenderParams & { title?: string }): Promise<string> {
  const res = await call<{ id?: string }>('/renders', {
    method: 'POST',
    timeoutMs: 60_000,
    body: {
      ...(args.title ? { title: args.title.slice(0, 120) } : {}),
      params: {
        prompt: args.prompt,
        duration_s: args.durationSec,
        megapixels: args.megapixels,
        steps: args.steps,
        aspect: args.aspect,
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
      },
    },
  });
  if (!res?.id) throw new CueError(502, `create returned no id: ${JSON.stringify(res).slice(0, 200)}`);
  return res.id;
}

export type CueStatus = 'queued' | 'running' | 'done' | 'failed';

export type CueRender = {
  status: CueStatus;
  /** Vendor error text. Logs only. */
  error?: string;
  refunded?: boolean;
};

export async function getCueRender(id: string): Promise<CueRender> {
  const r = await call<{ status?: string; error?: string; refunded?: boolean }>(
    `/renders/${encodeURIComponent(id)}`,
    { timeoutMs: 20_000 },
  );
  const raw = (r?.status ?? '').toLowerCase();
  const status: CueStatus = raw === 'done' || raw === 'failed' || raw === 'running' ? raw : 'queued';
  return { status, error: r?.error, refunded: r?.refunded };
}

/**
 * Fetch the finished file. Authenticated, so this cannot be handed to a
 * browser or to another provider — it is downloaded here and re-hosted in R2,
 * exactly like the other video path.
 */
export async function downloadCueRender(id: string): Promise<{ buffer: Buffer; contentType?: string }> {
  return downloadToBuffer(`${BASE}/renders/${encodeURIComponent(id)}/video`, 5, {
    authorization: `Bearer ${apiKey()}`,
  });
}

/** Best-effort cleanup. The vendor keeps the file otherwise; we already have
 *  our copy in R2, and their storage is not our library. Never throws. */
export async function deleteCueRender(id: string): Promise<void> {
  try {
    await call(`/renders/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 15_000 });
  } catch (e) {
    console.warn('[cue] delete failed for', id, e instanceof Error ? e.message : e);
  }
}

// ----------------------------------------------------------------- pricing

/**
 * What we charge a customer for one Cinema render, in Sociafy credits.
 *
 * Lives here rather than in lib/credits/pricing.ts on purpose: pricing.ts is
 * pure, synchronous and imported by client components, and this needs a network
 * call. The markup ratio and the canvas table still come from pricing.ts, so
 * there is one place to change the margin.
 *
 * Throws rather than guessing. A render we cannot price is a render we must not
 * queue — a fallback estimate that guesses low sells GPU time below cost, and
 * one that guesses high overcharges a customer for our own outage.
 */
export async function priceCinemaRender(args: {
  durationSec: number;
  quality: '480p' | '720p';
}): Promise<{ credits: number; megapixels: number; steps: number; providerUsd: number }> {
  const megapixels = CINEMA_MEGAPIXELS[args.quality];
  const est = await cueEstimate({ durationSec: args.durationSec, megapixels, steps: CINEMA_STEPS });
  return {
    credits: creditsFromProviderUsd(est.usd),
    megapixels,
    steps: CINEMA_STEPS,
    providerUsd: est.usd,
  };
}
