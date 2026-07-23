/* Thin Apify run-sync client shared by the trend + competitor scrapers.
   POSTs to run-sync-get-dataset-items and returns the dataset rows. Throws a
   readable error on missing token / non-2xx so callers can surface it. */

const BASE = 'https://api.apify.com/v2/acts';

export function apifyToken(): string | null {
  return process.env.APIFY_TOKEN?.trim() || null;
}

/** Typed Apify failure. `quota` marks account-level errors (usage limit / plan
    feature disabled / rate limit) that affect EVERY actor — callers abort the
    whole run and surface this rather than treating it as a per-handle miss. */
export class ApifyError extends Error {
  status: number;
  type: string | null;
  quota: boolean;
  constructor(actor: string, status: number, type: string | null, message: string) {
    super(`Apify ${actor} failed (${status}): ${type ?? ''} ${message}`.trim());
    this.name = 'ApifyError';
    this.status = status;
    this.type = type;
    this.quota = status === 429 || type === 'platform-feature-disabled' || /usage.*limit|hard limit|quota/i.test(message);
  }
}

export function isApifyQuotaError(e: unknown): e is ApifyError {
  return e instanceof ApifyError && e.quota;
}

/** Run an actor synchronously and return its dataset items. `actor` uses the
    tilde form, e.g. `apify~instagram-hashtag-scraper`. */
export async function runActor<T = Record<string, unknown>>(
  actor: string,
  input: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<T[]> {
  const token = apifyToken();
  if (!token) throw new Error('APIFY_TOKEN not configured');
  const url = `${BASE}/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let type: string | null = null;
    let message = body.slice(0, 200);
    try {
      const j = JSON.parse(body) as { error?: { type?: string; message?: string } };
      type = j.error?.type ?? null;
      message = j.error?.message ?? message;
    } catch { /* non-JSON body — keep raw */ }
    throw new ApifyError(actor, res.status, type, message);
  }
  return (await res.json()) as T[];
}

// ---- shared shape helpers over Instagram actor output ----

export type IgMusicInfo = {
  music_info?: { music_asset_info?: Record<string, unknown> } | null;
  original_sound_info?: Record<string, unknown> | null;
} | null;

/** Best-effort audio title/artist from IG's nested + inconsistent musicInfo. */
export function extractAudio(musicInfo: IgMusicInfo): { title: string | null; artist: string | null } {
  if (!musicInfo) return { title: null, artist: null };
  const asset = (musicInfo.music_info?.music_asset_info ?? musicInfo.original_sound_info ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const title = str(asset.title) ?? str(asset.song_name);
  const artist = str(asset.display_artist) ?? str(asset.artist_name)
    ?? str((asset.ig_artist as Record<string, unknown> | undefined)?.username);
  return { title, artist };
}

/** IG raw type + productType -> normalized post kind used by competitor intel. */
export function normalizeType(type: unknown, productType: unknown): { type: 'reel' | 'carousel' | 'image'; isReel: boolean } {
  const pt = String(productType ?? '').toLowerCase();
  const t = String(type ?? '');
  if (pt === 'clips' || pt === 'igtv' || t === 'Video') return { type: 'reel', isReel: true };
  if (t === 'Sidecar') return { type: 'carousel', isReel: false };
  return { type: 'image', isReel: false };
}

export function toInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
