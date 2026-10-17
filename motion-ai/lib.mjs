// Pure helpers for server.mjs (validated by lib.test.mjs).

export const SIZES = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] };
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
  if (!Number.isFinite(durationSec) || durationSec < 6 || durationSec > 20) return { error: 'bad_duration' };
  if (!validKey(b.videoKey) || !validKey(b.posterKey)) return { error: 'bad_key' };
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
  };
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
  if (!Array.isArray(s) || s.length < 3 || s.length > 6) return fallback;
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
