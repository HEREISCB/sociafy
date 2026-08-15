import { describe, expect, it } from 'vitest';
import { project, rubberband, springStep } from './spring';

/** Integrate to rest (or bail) and report the path. */
function run(
  from: number,
  to: number,
  { damping = 1, response = 0.3, velocity = 0 } = {},
  dt = 1 / 240,
  maxSteps = 4800,
) {
  let x = from;
  let v = velocity;
  const path: number[] = [x];
  let settledAt = -1;
  for (let i = 0; i < maxSteps; i++) {
    [x, v] = springStep(x, v, to, dt, damping, response);
    path.push(x);
    if (settledAt < 0 && Math.abs(x - to) < 0.5 && Math.abs(v) < 10) settledAt = (i + 1) * dt;
  }
  return { path, x, v, settledAt };
}

describe('project', () => {
  it('is the exponential form, not v²/2a', () => {
    // 1000 px/s with d=0.998 → (1000/1000)*0.998/0.002 = 499px
    expect(project(1000)).toBeCloseTo(499, 6);
  });

  it('is linear in velocity and signed', () => {
    expect(project(2000)).toBeCloseTo(2 * project(1000), 6);
    expect(project(-1000)).toBeCloseTo(-project(1000), 6);
    expect(project(0)).toBe(0);
  });

  it('projects further the slower the deceleration', () => {
    expect(project(1000, 0.998)).toBeGreaterThan(project(1000, 0.99));
  });

  it('turns a small flick into a big throw — 600px/s clears a 280px drawer', () => {
    expect(project(-600)).toBeLessThan(-280);
    // …and a nudge does not, so a twitch is not read as a flick.
    expect(project(-80)).toBeGreaterThan(-280);
  });
});

describe('rubberband', () => {
  it('always resists — displayed overshoot is under the raw one', () => {
    for (const raw of [1, 10, 50, 200, 1000]) {
      expect(rubberband(raw, 280)).toBeLessThan(raw);
      expect(rubberband(raw, 280)).toBeGreaterThan(0);
    }
  });

  it('is monotonic and asymptotes at the dimension — pull forever, travel 280px', () => {
    let prev = 0;
    for (const raw of [1, 10, 50, 200, 1000, 10_000]) {
      const y = rubberband(raw, 280);
      expect(y).toBeGreaterThan(prev);
      prev = y;
    }
    expect(prev).toBeLessThan(280);
    expect(rubberband(1e9, 280)).toBeCloseTo(280, 2);
  });

  it('is odd-symmetric, so both bounds feel the same', () => {
    expect(rubberband(-100, 280)).toBeCloseTo(-rubberband(100, 280), 10);
  });

  it('resists from the first pixel at roughly the constant, then harder', () => {
    // Initial slope is `constant` (0.55), not 1 — iOS resists immediately.
    expect(rubberband(1, 280) / 1).toBeCloseTo(0.55, 1);
    // By 200px of pull it is giving back well under half of it.
    expect(rubberband(200, 280) / 200).toBeLessThan(0.4);
  });
});

describe('springStep', () => {
  it('critically damped never overshoots', () => {
    const { path } = run(-280, 0, { damping: 1 });
    expect(Math.max(...path)).toBeLessThanOrEqual(0);
  });

  it('critically damped settles well inside a second at response 0.3', () => {
    const { settledAt, x } = run(-280, 0, { damping: 1 });
    expect(settledAt).toBeGreaterThan(0);
    expect(settledAt).toBeLessThan(0.6);
    expect(x).toBeCloseTo(0, 1);
  });

  it('damping 0.8 overshoots a little and still settles', () => {
    const { path, x } = run(-280, 0, { damping: 0.8 });
    const overshoot = Math.max(...path);
    expect(overshoot).toBeGreaterThan(0);
    expect(overshoot).toBeLessThan(280 * 0.1); // "a little", not a bounce house
    expect(x).toBeCloseTo(0, 1);
  });

  it('honours initial velocity — a shove toward the target arrives sooner', () => {
    const lazy = run(-280, 0, { damping: 1 }).settledAt;
    const shoved = run(-280, 0, { damping: 1, velocity: 900 }).settledAt;
    expect(shoved).toBeLessThan(lazy);
  });

  it('velocity away from the target still converges (a reversal, not a brick wall)', () => {
    const { path, x } = run(-140, 0, { damping: 1, velocity: -600 });
    expect(Math.min(...path)).toBeLessThan(-140); // it really did keep going the wrong way
    expect(x).toBeCloseTo(0, 1);
  });

  it('lower response is snappier', () => {
    expect(run(-280, 0, { response: 0.2 }).settledAt).toBeLessThan(
      run(-280, 0, { response: 0.5 }).settledAt,
    );
  });

  it('is stable at a 30fps step, not just at the substep', () => {
    const { x } = run(-280, 0, { damping: 0.8 }, 1 / 30, 600);
    expect(Number.isFinite(x)).toBe(true);
    expect(x).toBeCloseTo(0, 1);
  });
});
