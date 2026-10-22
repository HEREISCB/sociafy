// node --test motion-ai/
import test from 'node:test';
import assert from 'node:assert/strict';
import { validKey, parseSubmit, parseFootage, parseSegments, parseEdit, parseAudio, audioResult, jobLimits, segmentRange } from './lib.mjs';

test('keys stay inside users/', () => {
  assert.ok(validKey('users/abc/motion/1.mp4'));
  for (const k of ['other/x.mp4', 'users/../x', 'users/a b', '', null]) assert.ok(!validKey(k), String(k));
});

test('submit validation', () => {
  const ok = { prompt: 'hi', aspect: '1:1', durationSec: 8, videoKey: 'users/a/v.mp4', posterKey: 'users/a/p.jpg', brand: { colors: { primary: '#fff', text: 'red' }, logoUrl: 'http://169.254.169.254/x' } };
  const r = parseSubmit(ok);
  assert.equal(r.brand.colors.primary, '#fff');
  assert.equal(r.brand.colors.text, undefined);
  assert.equal(r.brand.logoUrl, '');
  assert.equal(parseSubmit({ ...ok, durationSec: 60 }).durationSec, 60);
  assert.equal(parseSubmit({ ...ok, durationSec: 180 }).durationSec, 180);
  assert.equal(parseSubmit({ ...ok, durationSec: 181 }).error, 'bad_duration');
  assert.equal(parseSubmit({ ...ok, durationSec: 5 }).error, 'bad_duration');
  assert.equal(parseSubmit({ ...ok, videoKey: 'x/v.mp4' }).error, 'bad_key');
  assert.equal(parseSubmit({ ...ok, aspect: '4:5' }).error, 'bad_aspect');
});

test('segments: valid manifest kept, bad one falls back', () => {
  const seg = (a, b) => ({ id: 'x', label: 'L', startSec: a, endSec: b, onScreenText: 't', suggestions: ['a', 'b', 'c', 'd'] });
  const good = parseSegments({ segments: [seg(0, 3), seg(3, 6), seg(6, 10)] }, 10);
  assert.equal(good.length, 3);
  assert.equal(good[2].suggestions.length, 3);
  const fb = (raw) => assert.deepEqual(parseSegments(raw, 10).map((s) => [s.startSec, s.endSec]), [[0, 10]]);
  fb(null);
  fb({ segments: [seg(0, 3), seg(4, 6), seg(6, 10)] }); // gap
  fb({ segments: [seg(0, 3), seg(3, 6), seg(6, 12)] }); // past duration
  fb({ segments: [seg(0, 10)] }); // too few
  // Long videos: about one segment per 4-6 s, so 60 s takes up to 15; 20 s still caps at 6.
  const even = (n, dur) => ({ segments: Array.from({ length: n }, (_, i) => seg((dur * i) / n, (dur * (i + 1)) / n)) });
  assert.equal(parseSegments(even(15, 60), 60).length, 15);
  assert.equal(parseSegments(even(16, 60), 60).length, 1);
  assert.equal(parseSegments(even(7, 20), 20).length, 1);
  // 3 minutes caps at 24 segments (7.5 s each), not 45.
  assert.equal(parseSegments(even(24, 180), 180).length, 24);
  assert.equal(parseSegments(even(25, 180), 180).length, 1);
});

test('segment range and limits grow with length', () => {
  assert.deepEqual(segmentRange(20), [3, 6]);
  assert.deepEqual(segmentRange(45), [8, 12]);
  assert.deepEqual(segmentRange(60), [10, 15]);
  assert.deepEqual(segmentRange(90), [15, 23]);
  assert.deepEqual(segmentRange(180), [18, 24]);
  const MIN = 60_000;
  // Up to 20 s: the limits that shipped before (claude 12, check 2, render 5, job 22, +5 footage).
  assert.deepEqual(jobLimits(20), { claude: 12 * MIN, check: 2 * MIN, render: 5 * MIN, footage: 5 * MIN, job: 22 * MIN, turns: 80 });
  assert.equal(jobLimits(12, true).job, 27 * MIN);
  const l = jobLimits(60);
  assert.equal(l.claude, 12 * MIN + 40 * 20_000);
  assert.equal(l.render, 10 * MIN);
  assert.equal(l.turns, 120);
  const xl = jobLimits(180);
  assert.equal(xl.claude, 50 * MIN);
  assert.equal(xl.render, 30 * MIN);
  assert.equal(xl.turns, 200);
  // Well inside the app's 2 h stuck-job window even before queueing.
  assert.ok(xl.job < 90 * MIN, `job ${xl.job / MIN} min`);
  // The app's browser poll windows add motionAiExtraMin(d) = ceil((d - 20) / 2) min over the 20 s budget: never less than this.
  for (let d = 6; d <= 180; d++) assert.ok(jobLimits(d).job - 22 * MIN <= Math.ceil(Math.max(0, d - 20) / 2) * MIN, `d=${d}`);
});

test('edit validation', () => {
  const ok = { parentCallId: 'b5bad192-97c5-429b-beee-aa6b8835c6c6', segmentId: 's1', instruction: ' Bigger headline ', videoKey: 'users/a/e.mp4', posterKey: 'users/a/e.jpg' };
  const r = parseEdit(ok);
  assert.equal(r.instruction, 'Bigger headline');
  assert.equal(r.segmentId, 's1');
  assert.equal(parseEdit({ ...ok, segmentId: undefined }).segmentId, null);
  assert.equal(parseEdit({ ...ok, segmentId: '../x' }).error, 'bad_segment');
  assert.equal(parseEdit({ ...ok, segmentId: 3 }).error, 'bad_segment');
  assert.equal(parseEdit({ ...ok, instruction: '   ' }).error, 'bad_instruction');
  assert.equal(parseEdit({ ...ok, instruction: 'x'.repeat(1001) }).error, 'bad_instruction');
  assert.equal(parseEdit({ ...ok, parentCallId: '../../etc' }).error, 'parent_not_found');
  assert.equal(parseEdit({ ...ok, posterKey: 'other/e.jpg' }).error, 'bad_key');
  assert.equal(parseEdit(null).error, 'bad_json');
});

test('audio validation and result', () => {
  assert.deepEqual(parseAudio(undefined), { narration: false, sfx: false, music: false, voice: '', language: '' });
  const a = parseAudio({ narration: true, sfx: false, music: 'yes', voice: 'Bella', language: 'hi-IN' });
  assert.deepEqual(a, { narration: true, sfx: false, music: false, voice: 'Bella', language: 'hi-IN' });
  assert.equal(parseAudio({ voice: '$(rm -rf /)', language: 'english please' }).voice, '');
  assert.equal(parseAudio({ language: 'english please' }).language, '');
  assert.equal(parseSubmit({ prompt: 'hi', aspect: '1:1', durationSec: 8, videoKey: 'users/a/v.mp4', posterKey: 'users/a/p.jpg' }).audio.sfx, false);
  const all = { narration: true, sfx: true, music: true };
  assert.deepEqual(audioResult(all, new Set()), { narration: false, sfx: false, music: false, warning: 'audio_unavailable' });
  assert.deepEqual(audioResult(all, new Set(['narration', 'sfx'])), { narration: true, sfx: true, music: false, warning: 'audio_partial' });
  assert.deepEqual(audioResult(all, new Set(['narration', 'sfx', 'music'])), { narration: true, sfx: true, music: true });
  assert.deepEqual(audioResult({ narration: false, sfx: false, music: false }, new Set()), { narration: false, sfx: false, music: false });
});

test('segments keep optional narration', () => {
  const seg = (a, b, narration) => ({ id: 'x', label: 'L', startSec: a, endSec: b, onScreenText: 't', narration });
  const s = parseSegments({ segments: [seg(0, 3, ' Three days. '), seg(3, 6), seg(6, 10, '')] }, 10);
  assert.equal(s[0].narration, 'Three days.');
  assert.ok(!('narration' in s[1]) && !('narration' in s[2]));
});

test('footage validation', () => {
  const ok = { prompt: 'hi', aspect: '9:16', durationSec: 10, videoKey: 'users/a/v.mp4', posterKey: 'users/a/p.jpg' };
  assert.equal(parseSubmit(ok).footage, undefined);
  assert.equal(parseSubmit({ ...ok, footage: [] }).footage, undefined);
  const r = parseSubmit({ ...ok, footage: [{ url: 'https://x.r2.dev/a.mp4', label: ' Barista ', startSec: 0, trimStartSec: 1.25, durationSec: 4 }] });
  assert.deepEqual(r.footage, [{ url: 'https://x.r2.dev/a.mp4', label: 'Barista', startSec: 0, trimStartSec: 1.3, durationSec: 4 }]);
  const bad = (footage) => assert.equal(parseSubmit({ ...ok, footage }).error, 'bad_footage', JSON.stringify(footage));
  const u = 'https://x.r2.dev/a.mp4';
  bad({ url: u }); // not an array
  bad([{ url: 'http://x/a.mp4' }]);
  bad([{ url: 'file:///etc/passwd' }]);
  bad([{}]);
  bad(Array(6).fill({ url: u }));
  bad([{ url: u, startSec: -1 }]);
  bad([{ url: u, startSec: 10 }]); // at/after the end
  bad([{ url: u, durationSec: 0 }]);
  bad([{ url: u, durationSec: 11 }]);
  bad([{ url: u, trimStartSec: '2' }]);
  bad([{ url: u, trimStartSec: NaN }]);
  bad([{ url: u, label: 5 }]);
  assert.equal(parseFootage(Array(5).fill({ url: u }), 10).length, 5);
});

test('segments keep the footage flag', () => {
  const seg = (a, b, footage) => ({ id: 'x', label: 'L', startSec: a, endSec: b, onScreenText: 't', footage });
  const s = parseSegments({ segments: [seg(0, 3, true), seg(3, 6, 'yes'), seg(6, 10)] }, 10);
  assert.equal(s[0].footage, true);
  assert.ok(!('footage' in s[1]) && !('footage' in s[2]));
});

test('poster = first headline fully on screen', async () => {
  const { posterTimeSec } = await import('./lib.mjs');
  const seg = (a, b, t) => ({ startSec: a, endSec: b, onScreenText: t });
  // first segment with text: max(2 + 0.6*3, 5 - 0.4) = 4.6
  assert.equal(posterTimeSec([seg(0, 2, ''), seg(2, 5, 'Big idea'), seg(5, 10, 'End')], 10), 4.6);
  // short segment: 0.6 rule wins over end − 0.4 (max(0.6, 0.6)), long one: max(6, 9.6)
  assert.equal(posterTimeSec([seg(0, 1, 'Hook'), seg(1, 10, '')], 10), 0.6);
  assert.equal(posterTimeSec([seg(0, 10, 'Hook'), seg(10, 12, '')], 12), 9.6);
  // no text anywhere → the hook
  assert.equal(posterTimeSec([seg(0, 3, ''), seg(3, 8, '')], 8), 2.6);
  // no manifest (single fallback segment) / nothing → 35%
  assert.equal(posterTimeSec([seg(0, 10, '')], 10), 3.5);
  assert.equal(posterTimeSec(null, 8), 2.8);
});

test('footage edit: submit, transcript, cut list', async () => {
  const { sttWords, packTranscript, snapToWords, parseEdl, remapWords } = await import('./lib.mjs');
  const ok = { prompt: 'Cut the pauses', aspect: '9:16', durationSec: 60, videoKey: 'users/a/v.mp4', posterKey: 'users/a/p.jpg' };
  const u = 'https://x.r2.dev/users/a/raw.mov';
  const r = parseSubmit({ ...ok, kind: 'footage-edit', autoLength: true, footage: [{ url: u, label: 'take 1', startSec: 3 }] });
  assert.deepEqual([r.kind, r.autoLength, r.footage], ['footage-edit', true, [{ url: u, label: 'take 1' }]]);
  assert.equal(parseSubmit({ ...ok, kind: 'footage-edit' }).error, 'bad_footage'); // needs a clip
  assert.equal(parseSubmit({ ...ok, kind: 'footage-edit', footage: [{ url: 'http://x/a.mp4' }] }).error, 'bad_footage');
  assert.equal(parseSubmit({ ...ok, kind: 'other' }).error, 'bad_kind');
  assert.equal(parseSubmit(ok).kind, undefined);

  const words = sttWords({ words: [
    { text: 'Hi', start: 0.5, end: 0.8, type: 'word', speaker_id: 'speaker_0' }, { text: ' ', start: 0.8, end: 0.9, type: 'spacing' },
    { text: 'um', start: 0.9, end: 1.2, type: 'word' }, { text: '(laughs)', start: 2.0, end: 2.4, type: 'audio_event' },
    { text: 'there', start: 2.5, end: 2.9, type: 'word' }, { text: 'bad', start: 'x', end: 1, type: 'word' },
  ] });
  assert.deepEqual(words, [[0.5, 0.8, 'Hi', 'speaker_0'], [0.9, 1.2, 'um'], [2, 2.4, '(laughs)'], [2.5, 2.9, 'there']]);
  assert.deepEqual(sttWords(null), []);
  const txt = packTranscript([{ id: 'f1', durationSec: 4, language: 'en', words }, { id: 'f2', durationSec: 3, words: [] }]);
  assert.match(txt, /## f1 \(4 s, en\)\n\(pause 0.5 s\)\n\[0.5-1.2\] Hi@0.5 um@0.9\n\(pause 0.8 s\)\n\[2-2.9\] \(laughs\)@2 there@2.5\n\(pause 1.1 s to the end\)/);
  assert.match(txt, /## f2 \(3 s, no speech\)/);

  // An edge inside a word moves out of it (80 ms pad, never into the neighbour).
  const r2 = (xs) => xs.map((x) => Math.round(x * 100) / 100);
  assert.deepEqual(r2(snapToWords(0.6, 2.7, words)), [0.42, 2.98]);
  assert.deepEqual(r2(snapToWords(0.85, 1.0, words)), [0.85, 1.28]);
  assert.deepEqual(r2(snapToWords(1.0, 1.5, words)), [0.82, 1.5]);

  const clips = [{ id: 'f1', durationSec: 4, words }, { id: 'f2', durationSec: 3, words: [] }];
  const e = parseEdl({ ranges: [{ clip: 'f1', start: 0.4, end: 0.95 }, { clip: 'f1', start: 2.45, end: 3 }, { clip: 'f2', start: 0, end: 9 }] }, clips, 60);
  // snapped out of "um", onto the 30 fps grid, clamped to the clip
  assert.deepEqual(e.ranges, [{ clip: 'f1', start: 0.4, end: 1.2667 }, { clip: 'f1', start: 2.4667, end: 3 }, { clip: 'f2', start: 0, end: 3 }]);
  const bad = (edl, max = 60) => assert.ok(parseEdl(edl, clips, max).error, JSON.stringify(edl));
  bad(null); bad({ ranges: [] }); bad({ ranges: [{ clip: 'f9', start: 0, end: 1 }] }); bad({ ranges: [{ clip: 'f1', start: '0', end: 1 }] });
  bad({ ranges: [{ clip: 'f1', start: 3.9, end: 3.95 }] });
  assert.match(parseEdl({ ranges: [{ clip: 'f1', start: 0, end: 4 }, { clip: 'f2', start: 0, end: 3 }] }, clips, 6).error, /over the 6 s limit/);

  const m = remapWords(e.ranges, clips);
  assert.equal(m.durationSec, 4.4);
  assert.deepEqual(m.ranges.map((x) => [x.outStart, x.outEnd]), [[0, 0.87], [0.87, 1.4], [1.4, 4.4]]);
  assert.deepEqual(m.words, [[0.1, 0.4, 'Hi'], [0.5, 0.8, 'um'], [0.9, 1.3, 'there']]);
});

test('footage edits get more time', () => {
  const MIN = 60_000;
  const l = jobLimits(30, true, true);
  assert.equal(l.claude, jobLimits(30).claude + 8 * MIN);
  assert.equal(l.job - jobLimits(30).job, 8 * MIN + 20 * MIN);
  assert.equal(l.turns, 120);
});
