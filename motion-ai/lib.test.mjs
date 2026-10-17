// node --test motion-ai/
import test from 'node:test';
import assert from 'node:assert/strict';
import { validKey, parseSubmit, parseSegments, parseEdit } from './lib.mjs';

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
