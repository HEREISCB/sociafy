// node --test motion-ai/
import test from 'node:test';
import assert from 'node:assert/strict';
import { validKey, parseSubmit, parseSegments, parseEdit, parseAudio, audioResult } from './lib.mjs';

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
  assert.equal(parseSubmit({ ...ok, durationSec: 30 }).error, 'bad_duration');
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
