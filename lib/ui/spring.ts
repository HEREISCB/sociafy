/**
 * Gesture math, in Apple's two designer-facing parameters (damping ratio +
 * response) rather than the physics triplet. No dependency — a critically
 * damped integrator is thirty lines and a spring library is not.
 *
 * The three exported pure functions are the whole vocabulary:
 *   project()    — where a flick is *going*, so we snap to that, not to here
 *   rubberband() — soft boundary instead of a hard stop
 *   springStep() — one integration step, shared by the rAF driver and tests
 */

/**
 * Apple's momentum projection (`Designing Fluid Interfaces` sample code):
 * the exponential-decay form, NOT the textbook v²/2a — they land in very
 * different places and only this one matches iOS scroll deceleration.
 *
 * @param velocity px/s at release
 * @param decelerationRate 0.998 = normal scroll feel, 0.99 = snappier
 * @returns the distance still to travel, in px
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/**
 * Progressive resistance past a boundary. Returns the *displayed* overshoot
 * for a raw one: it grows monotonically but asymptotes at
 * `dimension * constant`, so the edge feels like it pulls back rather than
 * like the element froze.
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * One semi-implicit Euler step of a unit-mass spring. Semi-implicit (velocity
 * updated before position) rather than explicit Euler because explicit gains
 * energy and can oscillate forever at large dt.
 *
 * @param damping damping ratio — 1 = critically damped (no overshoot), 0.8 = a little bounce
 * @param response seconds to reach the target; not a duration, a spring has none
 */
export function springStep(
  x: number,
  v: number,
  target: number,
  dt: number,
  damping: number,
  response: number,
): [number, number] {
  const w = (2 * Math.PI) / response;
  const nv = v + (-w * w * (x - target) - 2 * damping * w * v) * dt;
  return [x + nv * dt, nv];
}

export interface SpringOpts {
  /** damping ratio; 1 = critically damped. Default 1. */
  damping?: number;
  /** seconds. Default 0.3. */
  response?: number;
  /** px/s to start with. Omit to carry the spring's current velocity through
   *  the re-target — that is what stops a reversal feeling like a brick wall. */
  velocity?: number;
}

export interface Spring {
  readonly value: number;
  readonly velocity: number;
  /** Jump to a value and stay there (used when a gesture takes over). */
  set(next: number, velocity?: number): void;
  /** Re-target. Always continues from the current value, so it is interruptible. */
  to(next: number, opts?: SpringOpts): void;
  stop(): void;
}

const SUBSTEP = 1 / 240;

/** rAF-driven spring. `onFrame` gets the live value every frame. */
export function createSpring(onFrame: (x: number) => void, initial = 0): Spring {
  let x = initial;
  let v = 0;
  let target = initial;
  let damping = 1;
  let response = 0.3;
  let raf = 0;
  let last = 0;

  const tick = (now: number) => {
    // Clamp dt so a backgrounded tab doesn't integrate one enormous step.
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    for (let t = 0; t < dt; t += SUBSTEP) {
      [x, v] = springStep(x, v, target, Math.min(SUBSTEP, dt - t), damping, response);
    }
    if (Math.abs(x - target) < 0.5 && Math.abs(v) < 10) {
      x = target;
      v = 0;
      raf = 0;
      onFrame(x);
      return;
    }
    onFrame(x);
    raf = requestAnimationFrame(tick);
  };

  const cancel = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  return {
    get value() {
      return x;
    },
    get velocity() {
      return v;
    },
    set(next, velocity = 0) {
      cancel();
      x = target = next;
      v = velocity;
      onFrame(x);
    },
    to(next, opts = {}) {
      target = next;
      damping = opts.damping ?? 1;
      response = opts.response ?? 0.3;
      if (opts.velocity !== undefined) v = opts.velocity;
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    },
    stop() {
      cancel();
      v = 0;
    },
  };
}
