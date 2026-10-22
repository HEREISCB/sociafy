// Pure helpers for server.mjs (validated by lib.test.mjs).

export const SIZES = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] };
export const DURATION = { min: 6, max: 60 }; // the app's MOTION_AI.durationSec

// Segment count for a length: 3–6 up to 20 s, then about one per 4–6 s (10–15 at 60 s).
export const segmentRange = (dur) => [Math.max(3, Math.round(dur / 6)), Math.max(6, Math.ceil(dur / 4))];

// Per-step limits in ms. Up to 20 s: claude 12 min, check 2, render 5, job 22 (+5 with footage).
// Longer: claude +20 s per extra second (cap 25 min), render 10 s per second, check +1 s per second,
// so 60 s gets claude 25, check 2.7, render 10, job ~41 min. The app's motionAiExtraMin must stay >= job - 22.
// A footage edit ("raw": the user's own clips) adds 20 min for downloading up to 5 × 1 GB and
// transcribing, and 8 min of Claude time for reading the transcript and running the cut.
export function jobLimits(dur, footage = false, raw = false) {
  const MIN = 60_000, over = Math.max(0, dur - 20);
  const claude = Math.min(25 * MIN, 12 * MIN + over * 20_000) + (raw ? 8 * MIN : 0);
  const check = 2 * MIN + over * 1_000;
  const render = Math.max(5 * MIN, dur * 10_000);
  const fetch = raw ? 20 * MIN : footage ? 5 * MIN : 0;
  return { claude, check, render, footage: fetch || 5 * MIN, job: claude + check + render + 3 * MIN + fetch, turns: dur > 20 || raw ? 120 : 80 };
}

// Footage edits: the user's raw clips. Sizes/lengths the app also enforces before charging.
export const RAW = { maxBytes: 1024 ** 3, maxSourceSec: 600, fps: 30 };
const HEX = /^#[0-9a-fA-F]{3,8}$/;

// Keys go straight into the R2 URL path: only a user's prefix, no dot segments, no odd chars.
export const validKey = (k) => typeof k === 'string' && /^users\/[A-Za-z0-9._\-/]+$/.test(k) && !k.includes('..') && k.length < 512;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const url = (v) => (typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v) && v.length < 2048 ? v : '');

// Returns {error} or {job input}. The app is trusted (shared secret) but the post text is user content.
export function parseSubmit(b) {
  if (!b || typeof b !== 'object') return { error: 'bad_json' };
  const prompt = str(b.prompt, 4000);
  if (!prompt || b.prompt.length > 4000) return { error: 'bad_prompt' };
  if (!SIZES[b.aspect]) return { error: 'bad_aspect' };
  const durationSec = Number(b.durationSec);
  if (!Number.isFinite(durationSec) || durationSec < DURATION.min || durationSec > DURATION.max) return { error: 'bad_duration' };
  if (!validKey(b.videoKey) || !validKey(b.posterKey)) return { error: 'bad_key' };
  if (b.kind != null && b.kind !== 'footage-edit') return { error: 'bad_kind' };
  const raw = b.kind === 'footage-edit';
  // Raw clips are whole sources (no placement/trim): Claude decides the cut from the transcript.
  const footage = raw ? parseFootage(b.footage, durationSec)?.map(({ url: u, label }) => ({ url: u, label })) : parseFootage(b.footage, durationSec);
  if (!footage || (raw && !footage.length)) return { error: 'bad_footage' };
  const br = b.brand && typeof b.brand === 'object' ? b.brand : {};
  const colors = {};
  for (const c of ['primary', 'secondary', 'background', 'text', 'accent']) if (HEX.test(br.colors?.[c] ?? '')) colors[c] = br.colors[c];
  return {
    prompt, aspect: b.aspect, durationSec: Math.round(durationSec * 10) / 10,
    videoKey: b.videoKey, posterKey: b.posterKey,
    brand: {
      brandName: str(br.brandName, 80), tagline: str(br.tagline, 160), cta: str(br.cta, 120), colors,
      logoUrl: url(br.logoUrl), logoReverseUrl: url(br.logoReverseUrl),
      fontDisplayUrl: url(br.fontDisplayUrl), fontBodyUrl: url(br.fontBodyUrl),
      style: br.style === 'bold' ? 'bold' : 'soft',
    },
    audio: parseAudio(b.audio),
    ...(footage.length && { footage }),
    // durationSec is the cap for a footage edit; autoLength = the user left the length to us.
    ...(raw && { kind: 'footage-edit', autoLength: b.autoLength === true }),
  };
}

// ---- Footage edits (motion-cut + transcripts) ----

const r2 = (x) => Math.round(x * 100) / 100;
const frame = (x) => Math.round(x * RAW.fps) / RAW.fps;
// Frame-aligned seconds keep 4 decimals: x * 30 still rounds back to the exact frame (motion-cut does).
const r4 = (x) => Math.round(x * 10_000) / 10_000;

// ElevenLabs speech-to-text response → [[start, end, text, speaker?]]: spoken words and
// "(laughs)"-style audio events; spacing tokens dropped.
export function sttWords(resp) {
  const out = [];
  for (const w of Array.isArray(resp?.words) ? resp.words : []) {
    if (!w || (w.type !== 'word' && w.type !== 'audio_event')) continue;
    const s = Number(w.start), e = Number(w.end), t = String(w.text ?? '').trim();
    if (!t || !Number.isFinite(s) || !Number.isFinite(e) || e < s) continue;
    out.push([r2(s), r2(e), t, ...(w.speaker_id ? [String(w.speaker_id).slice(0, 20)] : [])]);
  }
  return out;
}

// transcript.txt: one line per phrase (split at pauses >= 0.4 s or every 12 words), each word
// with its start time, so Claude can read 10 minutes of speech and still cut on word edges.
export function packTranscript(clips) {
  return clips.map((c) => {
    const lines = [`## ${c.id} (${c.durationSec} s${c.language ? `, ${c.language}` : ''}${c.words.length ? '' : ', no speech'})`];
    let cur = [], prevEnd = 0;
    const flush = () => { if (cur.length) lines.push(`[${cur[0][0]}-${cur.at(-1)[1]}] ${cur.map((w) => `${w[2]}@${w[0]}`).join(' ')}`); cur = []; };
    for (const w of c.words) {
      const gap = w[0] - prevEnd;
      if (gap >= 0.4 || cur.length >= 12) { flush(); if (gap >= 0.4) lines.push(`(pause ${r2(gap)} s)`); }
      cur.push(w);
      prevEnd = w[1];
    }
    flush();
    if (c.words.length && c.durationSec - prevEnd >= 0.4) lines.push(`(pause ${r2(c.durationSec - prevEnd)} s to the end)`);
    return lines.join('\n');
  }).join('\n\n');
}

// Never cut inside a word: an edge inside one moves out to just before/after it (80 ms pad,
// never into the neighbouring word). ASR timestamps drift 50–100 ms; the pad absorbs it.
export function snapToWords(start, end, words = []) {
  const PAD = 0.08;
  for (let i = 0; i < words.length; i++) {
    const [s, e] = words[i];
    if (start > s && start < e) start = Math.max(i ? words[i - 1][1] : 0, s - PAD, 0);
    if (end > s && end < e) end = Math.min(i < words.length - 1 ? words[i + 1][0] : Infinity, e + PAD);
  }
  return [start, end];
}

// edl.json from Claude → { ranges: [{clip, start, end}] } snapped to words and the 30 fps grid,
// or { error } in words Claude can act on. Total must fit the paid cap.
export function parseEdl(raw, clips, maxSec) {
  const list = raw?.ranges;
  if (!Array.isArray(list) || !list.length || list.length > 200) return { error: 'edl.json needs "ranges": 1-200 items of {clip, start, end}' };
  const byId = new Map(clips.map((c) => [c.id, c]));
  const ranges = [];
  for (const [i, r] of list.entries()) {
    const c = byId.get(r?.clip);
    if (!c) return { error: `range ${i}: unknown clip ${JSON.stringify(r?.clip)} (have ${[...byId.keys()].join(', ')})` };
    if (typeof r.start !== 'number' || typeof r.end !== 'number' || !Number.isFinite(r.start) || !Number.isFinite(r.end)) return { error: `range ${i}: start/end must be numbers (seconds)` };
    let [s, e] = snapToWords(Math.max(0, r.start), Math.min(c.durationSec, r.end), c.words);
    s = frame(Math.max(0, s)); e = frame(Math.min(c.durationSec, e));
    if (e - s < 0.2) return { error: `range ${i}: shorter than 0.2 s after snapping (${s}-${e})` };
    ranges.push({ clip: c.id, start: r4(s), end: r4(e) });
  }
  const total = r2(ranges.reduce((n, r) => n + (r.end - r.start), 0));
  if (total > maxSec + 0.05) return { error: `total ${total} s is over the ${maxSec} s limit: cut more` };
  return { ranges, total };
}

// Where each range lands in the cut, and every word fully kept, on the cut's timeline.
export function remapWords(ranges, clips) {
  const byId = new Map(clips.map((c) => [c.id, c]));
  let t = 0;
  const placed = [], words = [];
  for (const r of ranges) {
    const out = { ...r, outStart: r2(t), outEnd: r2(t + r.end - r.start) };
    placed.push(out);
    for (const [s, e, text] of byId.get(r.clip)?.words ?? []) {
      if (s >= r.start - 0.05 && e <= r.end + 0.05) words.push([r2(Math.max(out.outStart, s - r.start + t)), r2(Math.min(out.outEnd, e - r.start + t)), text]);
    }
    t += r.end - r.start;
  }
  return { ranges: placed, words, durationSec: r2(t) };
}

// submit.footage → [{url, label, startSec?, trimStartSec?, durationSec?}] or null when malformed.
// Unlike brand assets, footage is never silently dropped: the app charged for a hybrid.
export function parseFootage(f, dur) {
  if (f == null) return [];
  if (!Array.isArray(f) || f.length > 5) return null;
  const out = [];
  for (const x of f) {
    if (!x || typeof x !== 'object' || !url(x.url) || (x.label != null && typeof x.label !== 'string')) return null;
    const o = { url: x.url, label: str(x.label, 80) };
    for (const [k, min, max] of [['startSec', 0, dur - 0.5], ['trimStartSec', 0, 600], ['durationSec', 0.5, dur]]) {
      if (x[k] == null) continue;
      if (typeof x[k] !== 'number' || !Number.isFinite(x[k]) || x[k] < min || x[k] > max) return null;
      o[k] = Math.round(x[k] * 10) / 10;
    }
    out.push(o);
  }
  return out;
}

// submit.audio → {narration, sfx, music, voice, language}. Missing/odd fields fall back to defaults.
export function parseAudio(a) {
  const o = a && typeof a === 'object' ? a : {};
  const flag = (v, d) => (typeof v === 'boolean' ? v : d);
  const voice = typeof o.voice === 'string' && /^[A-Za-z0-9 ._'-]{1,60}$/.test(o.voice.trim()) ? o.voice.trim() : '';
  const language = typeof o.language === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(o.language.trim()) ? o.language.trim() : '';
  return { narration: flag(o.narration, false), sfx: flag(o.sfx, false), music: flag(o.music, false), voice, language };
}

// What the render actually carries → result.audio. `added` = kinds whose files the final index.html uses.
export function audioResult(requested, added) {
  const r = { narration: added.has('narration'), sfx: added.has('sfx'), music: added.has('music') };
  const want = ['narration', 'sfx', 'music'].filter((k) => requested?.[k]);
  if (want.length && !want.some((k) => r[k])) r.warning = 'audio_unavailable';
  else if (want.some((k) => !r[k])) r.warning = 'audio_partial';
  return r;
}

// segments.json from Claude → validated manifest, or a single whole-video segment.
export function parseSegments(raw, dur) {
  const fallback = [{ id: 's1', label: 'Full video', startSec: 0, endSec: dur, onScreenText: '', suggestions: [] }];
  const s = raw?.segments;
  if (!Array.isArray(s) || s.length < 3 || s.length > segmentRange(dur)[1]) return fallback;
  let t = 0;
  for (const g of s) {
    if (typeof g?.startSec !== 'number' || typeof g?.endSec !== 'number') return fallback;
    if (Math.abs(g.startSec - t) > 0.05 || g.endSec <= g.startSec) return fallback;
    t = g.endSec;
  }
  if (Math.abs(t - dur) > 0.05) return fallback;
  return s.map((g, i) => ({
    id: str(g.id, 20) || `s${i + 1}`, label: str(g.label, 60),
    startSec: i === 0 ? 0 : s[i - 1].endSec, endSec: i === s.length - 1 ? dur : g.endSec,
    onScreenText: str(g.onScreenText, 400),
    ...(str(g.narration, 400) && { narration: str(g.narration, 400) }),
    ...(g.footage === true && { footage: true }),
    suggestions: (Array.isArray(g.suggestions) ? g.suggestions : []).map((x) => str(x, 120)).filter(Boolean).slice(0, 3),
  }));
}

// POST /motion-ai/edit body → {error} or edit input. parentCallId is a job dir name, so UUID only.
export function parseEdit(b) {
  if (!b || typeof b !== 'object') return { error: 'bad_json' };
  if (typeof b.parentCallId !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(b.parentCallId)) return { error: 'parent_not_found' };
  if (b.segmentId != null && (typeof b.segmentId !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/.test(b.segmentId))) return { error: 'bad_segment' };
  const instruction = str(b.instruction, 1000);
  if (!instruction || b.instruction.length > 1000) return { error: 'bad_instruction' };
  if (!validKey(b.videoKey) || !validKey(b.posterKey)) return { error: 'bad_key' };
  return { parentCallId: b.parentCallId, segmentId: b.segmentId ?? null, instruction, videoKey: b.videoKey, posterKey: b.posterKey };
}

// Poster frame (seconds): the moment the first headline is fully on screen — 60% into the first
// segment with on-screen text (the hook if none has text), but no later than 0.4 s before it ends.
// A single segment is parseSegments' "no manifest" fallback: no timing to trust, so 35% in.
export function posterTimeSec(segments, dur) {
  const s = Array.isArray(segments) && segments.length > 1 ? segments : [];
  const g = s.find((x) => String(x?.onScreenText || '').trim()) || s[0];
  const t = g ? Math.max(g.startSec + 0.6 * (g.endSec - g.startSec), g.endSec - 0.4) : dur * 0.35;
  return Math.round(Math.min(Math.max(t, 0), Math.max(dur - 0.1, 0)) * 100) / 100;
}
