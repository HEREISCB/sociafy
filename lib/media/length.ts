import { MOTION_AI } from '../ai/models';

/** Slider stops: every second up to a minute, then every 5 s (a 3-minute range in 1 s steps can't be hit on a 300 px track). */
const { min: LEN_MIN, max: LEN_MAX } = MOTION_AI.durationSec;
export const LENGTH_STOPS = Array.from({ length: LEN_MAX - LEN_MIN + 1 }, (_, i) => LEN_MIN + i).filter((n) => n <= 60 || n % 5 === 0);
/** Slider position (0 = AI decides / default) for a length; an off-stop length (from the chat) snaps to the nearest stop. */
export const lengthStop = (n: number | null) => (n == null ? 0 : 1 + LENGTH_STOPS.reduce((b, v, i) => (Math.abs(v - n) < Math.abs(LENGTH_STOPS[b] - n) ? i : b), 0));
/** 45 → "45s", 150 → "2:30". */
export const fmtLength = (n: number) => (n < 60 ? `${n}s` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`);
/** For aria-valuetext: 150 → "2 min 30 s". */
export const spokenLength = (n: number) => (n < 60 ? `${n} seconds` : `${Math.floor(n / 60)} min${n % 60 ? ` ${n % 60} s` : ''}`);
