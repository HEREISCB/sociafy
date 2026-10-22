#!/usr/bin/env node
// motion-cut: the only footage tool a footage-edit job's Claude may run (installed as $BASE/bin/motion-cut,
// next to lib.mjs). Reads sources.json + transcript.json from the project, cuts the ranges in an EDL out of
// the user's raw clips and joins them into one H.264 + AAC file with 30 ms audio fades at every cut.
//   motion-cut <edl.json> [--name cut] [--mute]
// edl.json: {"ranges":[{"clip":"f1","start":1.24,"end":6.8}, …]}  (seconds into each source clip)
// Writes assets/footage/<name>.mp4 + assets/footage/<name>.json ({durationSec, ranges with outStart/outEnd,
// words on the cut's own timeline}). Prints one JSON line; exit 1 on failure.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseEdl, remapWords, RAW } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const out = (o, code = 0) => { console.log(JSON.stringify(o)); process.exit(code); };
const die = (error) => out({ ok: false, error }, 1);
const ff = (bin, a) => {
  const p = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', ...a], { timeout: 5 * 60_000, encoding: 'utf8' });
  if (p.status !== 0) throw new Error(`${bin} failed: ${(p.stderr || p.error?.message || '').slice(-300)}`);
  return p.stdout;
};

function main() {
  const [edlFile] = args;
  const name = opt('name') ?? 'cut';
  if (!edlFile || !/^[a-z0-9_-]{1,32}$/.test(name)) die('usage: motion-cut <edl.json> [--name <a-z0-9_->] [--mute]');
  let src, transcript, edl;
  try {
    src = JSON.parse(fs.readFileSync('sources.json', 'utf8'));
    transcript = JSON.parse(fs.readFileSync('transcript.json', 'utf8'));
    edl = JSON.parse(fs.readFileSync(edlFile, 'utf8'));
  } catch (e) { die(`read failed: ${e.message}`); }
  const clips = src.clips.map((c) => ({ ...c, words: transcript[c.id]?.words ?? [] }));
  for (const c of clips) if (!fs.existsSync(c.file)) die(`source ${c.id} is gone (sources are kept 7 days): keep the existing cut`);
  const p = parseEdl(edl, clips, src.maxSec);
  if (p.error) die(p.error);

  const work = '../work';
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync('assets/footage', { recursive: true });
  const byId = new Map(clips.map((c) => [c.id, c]));
  const list = [];
  for (const [i, r] of p.ranges.entries()) {
    // Whole frames (parseEdl put the edges on the 30 fps grid): each part is exactly N frames, so the
    // parts add up to the timeline cut.json reports and captions don't drift.
    const f0 = Math.round(r.start * RAW.fps), f1 = Math.round(r.end * RAW.fps);
    const c = byId.get(r.clip), d = ((f1 - f0) / RAW.fps).toFixed(6), seg = `${work}/s${i}.mkv`;
    // HDR phone footage (HLG/PQ) is tone-mapped to SDR, or it plays back washed out.
    const tone = c.hdr ? 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,' : '';
    ff('ffmpeg', ['-y', '-ss', (f0 / RAW.fps).toFixed(6), '-t', d, '-i', c.file,
      ...(c.hasAudio ? [] : ['-f', 'lavfi', '-t', d, '-i', 'anullsrc=r=48000:cl=stereo']),
      '-map', '0:v:0', '-map', c.hasAudio ? '0:a:0' : '1:a:0',
      '-vf', `${tone}scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))',fps=${RAW.fps},format=yuv420p`,
      '-af', `aresample=48000,afade=t=in:d=0.03,afade=t=out:st=${Math.max(0, d - 0.03).toFixed(3)}:d=0.03`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'pcm_s16le', '-ac', '2', seg]);
    list.push(`file '${`s${i}.mkv`}'`);
  }
  // PCM in the parts, AAC once at the end: per-part AAC priming would drift the sound off the picture.
  fs.writeFileSync(`${work}/list.txt`, list.join('\n'));
  ff('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', `${work}/list.txt`, '-c', 'copy', `${work}/joined.mkv`]);
  // Write beside, then rename: in an edit job these names are hard links to the parent's files,
  // and writing through them would change the parent's video too.
  const file = `assets/footage/${name}.mp4`, json = `assets/footage/${name}.json`;
  ff('ffmpeg', ['-y', '-i', `${work}/joined.mkv`, '-c:v', 'copy', ...(args.includes('--mute') ? ['-an'] : ['-c:a', 'aac', '-b:a', '192k']), '-movflags', '+faststart', `${work}/out.mp4`]);
  const durationSec = Math.round(Number(ff('ffprobe', ['-show_entries', 'format=duration', '-of', 'csv=p=0', `${work}/out.mp4`]).trim()) * 100) / 100;
  const map = remapWords(p.ranges, clips);
  fs.writeFileSync(`${work}/out.json`, JSON.stringify({ ...map, durationSec }));
  fs.renameSync(`${work}/out.mp4`, file);
  fs.renameSync(`${work}/out.json`, json);
  fs.rmSync(work, { recursive: true, force: true });
  out({ ok: true, file, json, durationSec, cutsAt: map.ranges.slice(1).map((r) => r.outStart), words: map.words.length });
}

try { main(); } catch (e) { die(String(e.message || e).slice(0, 400)); }
