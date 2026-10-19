#!/usr/bin/env node
// motion-audio: the only audio tool the job's Claude may run (installed as $BASE/bin/motion-audio).
// ElevenLabs REST, same calls the owner's local projects make (scripts/tts.py): TTS for narration,
// sound-generation for SFX, music for a bed. Writes assets/audio/<id>.mp3 + a ledger the worker reads.
//   motion-audio tts   <id> "<text>" [--voice <id|name>] [--lang <code>] [--speed 0.7-1.2]
//   motion-audio sfx   <id> "<prompt>" [--dur 0.5-10]
//   motion-audio music <id> "<prompt>" --dur <sec>
//   motion-audio voices
// Prints one JSON line. Exit 1 on failure: then leave that sound out, never reference a missing file.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const API = 'https://api.elevenlabs.io/v1';
const KEY = process.env.ELEVENLABS_API_KEY || '';
const KINDS = (process.env.MOTION_AUDIO_KINDS ?? 'narration,sfx,music').split(',');
const DEFAULT_VOICE = 'hpp4J3VqNfWAUOO0d1Us'; // Bella, the owner's narrator voice
const DIR = 'assets/audio';
const [cmd, id, text, ...rest] = process.argv.slice(2);
const opt = (k) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const out = (o, code = 0) => { console.log(JSON.stringify(o)); process.exit(code); };
const die = (error) => out({ ok: false, error }, 1);

async function api(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(90_000),
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = '';
    try { const d = await r.json(); detail = d.detail?.status || d.detail?.message || d.detail || ''; } catch {}
    throw new Error(`elevenlabs ${r.status} ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 160)}`);
  }
  return r;
}

async function voiceId(v) {
  if (!v) return DEFAULT_VOICE;
  if (/^[A-Za-z0-9]{20}$/.test(v)) return v;
  const { voices = [] } = await (await api('/voices')).json();
  const hit = voices.find((x) => x.name.toLowerCase().startsWith(v.toLowerCase()));
  return hit ? hit.voice_id : DEFAULT_VOICE;
}

async function main() {
  if (!KEY) die('audio_unavailable: no ElevenLabs key');
  if (cmd === 'voices') {
    const { voices = [] } = await (await api('/voices')).json();
    out({ ok: true, voices: voices.map((x) => ({ id: x.voice_id, name: x.name })) });
  }
  const kind = { tts: 'narration', sfx: 'sfx', music: 'music' }[cmd];
  if (!kind) die('usage: motion-audio tts|sfx|music <id> "<text>" [...] | voices');
  if (!KINDS.includes(kind)) die(`${kind} is not enabled for this job`);
  if (!/^[a-z0-9_-]{1,32}$/.test(id || '')) die('id must match [a-z0-9_-]{1,32}');
  if (!text || text.length > 600) die('text must be 1-600 chars');
  const num = (k, lo, hi, d) => { const n = Number(opt(k) ?? d); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

  let r;
  if (kind === 'narration') {
    const body = { text, model_id: 'eleven_v4', voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true, speed: num('speed', 0.7, 1.2, 1) } };
    const path = `/text-to-speech/${await voiceId(opt('voice'))}?output_format=mp3_44100_128`;
    const lang = opt('lang');
    try { r = await api(path, lang ? { ...body, language_code: lang } : body); }
    catch (e) { if (!lang || !/ 4\d\d /.test(e.message)) throw e; r = await api(path, body); } // model may not take language_code
  } else if (kind === 'sfx') {
    r = await api('/sound-generation?output_format=mp3_44100_128', { text, duration_seconds: num('dur', 0.5, 10, 1.5), prompt_influence: 0.5 });
  } else {
    const dur = num('dur', 3, 60, 12); // up to the longest video (6–60 s)
    try { r = await api('/music?output_format=mp3_44100_128', { prompt: text, music_length_ms: Math.round(dur * 1000), model_id: 'music_v1', force_instrumental: true }); }
    catch (e) { // the music API needs a paid plan (402): a looping sound-generation bed instead
      if (!/ 40[23] /.test(e.message)) throw e;
      r = await api('/sound-generation?output_format=mp3_44100_128', { text: `${text}, instrumental background music bed, no vocals`, duration_seconds: Math.min(dur, 30), prompt_influence: 0.5, loop: true }); // sound-generation caps at 30 s
    }
  }
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(DIR, { recursive: true });
  const file = `${DIR}/${id}.mp3`;
  fs.writeFileSync(file, buf);
  const durationSec = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
  const ledgerFile = `${DIR}/ledger.json`;
  let ledger = [];
  try { ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); } catch {}
  ledger = ledger.filter((x) => x.file !== file).concat({ file, kind, text, durationSec, cost: Number(r.headers.get('character-cost') || r.headers.get('x-character-count')) || null });
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1));
  out({ ok: true, file, kind, durationSec: Math.round(durationSec * 100) / 100 });
}

main().catch((e) => die(`audio_unavailable: ${String(e.message || e).slice(0, 200)}`));
