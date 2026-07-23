/* Trend lifecycle forecasting.
   Fits a least-squares parabola E = A·t² + B·t + C to each entity's engagement
   time series across snapshots. A<0 => a peak exists at t* = -B/2A. From that we
   derive lifecycle stage, projected peak date, and a confidence from fit quality.
   Pure + deterministic: `now` is injected so the self-check (scripts/check-intel.ts)
   can pin time. */

const DAY_MS = 86_400_000;

export type ForecastRow = {
  hashtagQueried: string;
  postHashtags: string[] | null;
  likes: number | null;
  comments: number | null;
  views: number | null;
  audioTitle: string | null;
  audioArtist: string | null;
  isReel: boolean | null;
};

export type ForecastSnapshot = { fetchedAt: Date | string; rows: ForecastRow[] };

export type Stage = 'emerging' | 'rising' | 'peaking' | 'declining';

export type Forecast = {
  entity: string;
  kind: 'hashtag' | 'audio';
  stage: Stage;
  strengthNow: number;
  peakStrength: number | null;
  velocityPct: number; // normalized slope, %/day
  peakAt: string | null; // ISO
  hoursToPeak: number | null;
  confidence: number; // 0-100
  points: number;
  series: number[]; // per-snapshot strength, oldest->newest, for sparkline
  fitBase?: number; // niche-fit deterministic base, attached by caller
};

export type ForecastOptions = {
  now?: Date;
  horizonHours?: number; // watchlist window ahead, default 48
  minPoints?: number; // min observations to fit, default 3
};

// engagement weight per post: comments are higher-intent, views discounted
function eng(r: ForecastRow): number {
  return (r.likes ?? 0) + 3 * (r.comments ?? 0) + 0.05 * (r.views ?? 0);
}

/** Solve 3x3 linear system by Gaussian elimination; null if singular. */
function solve3(m: number[][], v: number[]): [number, number, number] | null {
  const a = m.map((row, i) => [...row, v[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c < 4; c++) a[r][c] -= f * a[col][c];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}

export type QuadFit = { A: number; B: number; C: number; r2: number };

/** Least-squares quadratic over (x,y) points; needs >=3 distinct x. */
export function fitQuadratic(xs: number[], ys: number[]): QuadFit | null {
  const n = xs.length;
  if (n < 3 || new Set(xs).size < 3) return null;
  let S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i], x2 = x * x;
    S1 += x; S2 += x2; S3 += x2 * x; S4 += x2 * x2;
    T0 += y; T1 += x * y; T2 += x2 * y;
  }
  const sol = solve3([[S4, S3, S2], [S3, S2, S1], [S2, S1, n]], [T2, T1, T0]);
  if (!sol) return null;
  const [A, B, C] = sol;
  const mean = T0 / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], pred = A * x * x + B * x + C;
    ssRes += (ys[i] - pred) ** 2;
    ssTot += (ys[i] - mean) ** 2;
  }
  const r2 = ssTot < 1e-9 ? 0 : Math.max(0, 1 - ssRes / ssTot);
  return { A, B, C, r2 };
}

function classify(
  fit: QuadFit,
  tLast: number,
  tStar: number | null,
  velPct: number,
  firstSeenFrac: number,
): Stage {
  if (firstSeenFrac > 0.5 && velPct > 3) return 'emerging';
  if (tStar !== null && fit.A < 0) {
    if (tStar < tLast - 0.25) return 'declining';
    if (tStar <= tLast + 3) return 'peaking';
    return 'rising';
  }
  if (velPct < -3) return 'declining';
  if (velPct > 3) return 'rising';
  return 'peaking';
}

function buildEntity(
  entity: string,
  kind: 'hashtag' | 'audio',
  ts: number[], // days since first snapshot, per observation
  strengths: number[],
  seriesFull: number[],
  firstSeenFrac: number,
  tLastAll: number,
  nowT: number,
  firstMs: number,
  horizonHours: number,
): Forecast | null {
  const fit = fitQuadratic(ts, strengths);
  const strengthNow = strengths[strengths.length - 1];
  const tLast = ts[ts.length - 1];
  let tStar: number | null = null;
  let peakStrength: number | null = null;
  if (fit && fit.A < -1e-9) {
    tStar = -fit.B / (2 * fit.A);
    peakStrength = fit.A * tStar * tStar + fit.B * tStar + fit.C;
  }
  // slope at last observed point, normalized to %/day of current level
  const slope = fit ? 2 * fit.A * tLast + fit.B : 0;
  const velPct = strengthNow > 1 ? (slope / strengthNow) * 100 : 0;
  const stage = fit
    ? classify(fit, tLast, tStar, velPct, firstSeenFrac)
    : velPct > 3 ? 'rising' : 'peaking';

  let peakAt: string | null = null;
  let hoursToPeak: number | null = null;
  if (tStar !== null && Number.isFinite(tStar)) {
    const peakMs = firstMs + tStar * DAY_MS;
    peakAt = new Date(peakMs).toISOString();
    hoursToPeak = Math.round((peakMs - (firstMs + nowT * DAY_MS)) / 3_600_000);
  }

  // confidence: fit quality x sample depth x proximity of peak to now
  const pointsFactor = Math.min(1, (ts.length - 2) / 3);
  const r2 = fit?.r2 ?? 0;
  let horizonFactor = 1;
  if (hoursToPeak !== null) horizonFactor = 1 / (1 + Math.abs(hoursToPeak) / (horizonHours * 1.5));
  const confidence = Math.round(100 * r2 * pointsFactor * horizonFactor);

  return {
    entity, kind, stage, strengthNow,
    peakStrength: peakStrength !== null ? Math.round(peakStrength) : null,
    velocityPct: Math.round(velPct * 10) / 10,
    peakAt, hoursToPeak, confidence,
    points: ts.length,
    series: seriesFull,
  };
}

export function normTag(t: string): string {
  return t.replace(/^#/, '').trim().toLowerCase();
}

/** Build per-entity forecasts across ordered snapshots (any order accepted). */
export function buildForecasts(snapshotsIn: ForecastSnapshot[], opts: ForecastOptions = {}): Forecast[] {
  const snaps = [...snapshotsIn]
    .map((s) => ({ ms: new Date(s.fetchedAt).getTime(), rows: s.rows }))
    .filter((s) => Number.isFinite(s.ms))
    .sort((a, b) => a.ms - b.ms);
  if (snaps.length < (opts.minPoints ?? 3)) return [];

  const firstMs = snaps[0].ms;
  const nowMs = (opts.now ?? new Date()).getTime();
  const nowT = (nowMs - firstMs) / DAY_MS;
  const tLastAll = (snaps[snaps.length - 1].ms - firstMs) / DAY_MS;
  const horizonHours = opts.horizonHours ?? 48;
  const minPoints = opts.minPoints ?? 3;

  // accumulate strength per entity per snapshot
  const hashMaps: Map<string, number>[] = [];
  const audioMaps: Map<string, number>[] = [];
  const audioLabel = new Map<string, string>();
  for (const s of snaps) {
    const h = new Map<string, number>();
    const a = new Map<string, number>();
    for (const r of s.rows) {
      const e = eng(r);
      const tags = new Set<string>();
      if (r.hashtagQueried) tags.add(normTag(r.hashtagQueried));
      for (const t of r.postHashtags ?? []) tags.add(normTag(t));
      for (const t of tags) if (t) h.set(t, (h.get(t) ?? 0) + e);
      if (r.audioTitle) {
        const key = normTag(r.audioTitle);
        a.set(key, (a.get(key) ?? 0) + e);
        if (!audioLabel.has(key)) audioLabel.set(key, r.audioTitle.trim());
      }
    }
    hashMaps.push(h);
    audioMaps.push(a);
  }

  const out: Forecast[] = [];
  const build = (maps: Map<string, number>[], kind: 'hashtag' | 'audio', label: (k: string) => string) => {
    const keys = new Set<string>();
    for (const m of maps) for (const k of m.keys()) keys.add(k);
    for (const key of keys) {
      const ts: number[] = [];
      const strengths: number[] = [];
      const seriesFull: number[] = [];
      let firstIdx = -1;
      for (let i = 0; i < snaps.length; i++) {
        const v = maps[i].get(key) ?? 0;
        seriesFull.push(Math.round(v));
        if (maps[i].has(key)) {
          if (firstIdx < 0) firstIdx = i;
          ts.push((snaps[i].ms - firstMs) / DAY_MS);
          strengths.push(v);
        }
      }
      if (ts.length < minPoints) continue;
      const firstSeenFrac = firstIdx / (snaps.length - 1);
      const f = buildEntity(label(key), kind, ts, strengths, seriesFull, firstSeenFrac, tLastAll, nowT, firstMs, horizonHours);
      if (f) out.push(f);
    }
  };
  build(hashMaps, 'hashtag', (k) => k);
  build(audioMaps, 'audio', (k) => audioLabel.get(k) ?? k);
  return out;
}

/** Entities projected to peak within the horizon window (going viral soon). */
export function watchlist(forecasts: Forecast[], horizonHours = 48): Forecast[] {
  return forecasts
    .filter((f) => f.hoursToPeak !== null && f.hoursToPeak >= -12 && f.hoursToPeak <= horizonHours && f.velocityPct > -2)
    .sort((a, b) => b.confidence - a.confidence || (a.hoursToPeak ?? 0) - (b.hoursToPeak ?? 0));
}

/** Deterministic niche-fit base 0-100: hashtag co-occurrence with niche tags + keyword affinity. */
export function nicheFitBase(
  entity: string,
  allRows: ForecastRow[],
  nicheTags: string[],
  nicheText: string | null,
): number {
  const target = normTag(entity);
  const niche = new Set(nicheTags.map(normTag).filter(Boolean));
  const words = new Set(
    (nicheText ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3),
  );
  for (const t of niche) words.add(t);

  // co-occurrence: of posts carrying `target`, how many also carry a niche tag
  let carrying = 0, coOccur = 0;
  for (const r of allRows) {
    const tags = new Set<string>();
    if (r.hashtagQueried) tags.add(normTag(r.hashtagQueried));
    for (const t of r.postHashtags ?? []) tags.add(normTag(t));
    if (!tags.has(target)) continue;
    carrying++;
    for (const t of tags) if (t !== target && niche.has(t)) { coOccur++; break; }
  }
  const coScore = carrying > 0 ? coOccur / carrying : 0;

  // keyword affinity: does the tag string share tokens with niche vocabulary
  let kw = 0;
  for (const w of words) if (w && (target.includes(w) || w.includes(target))) { kw = 1; break; }

  const raw = 0.7 * coScore + 0.3 * kw;
  return Math.round(Math.min(1, raw) * 100);
}
