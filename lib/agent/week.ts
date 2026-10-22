import type { PostKind } from '../platforms/capabilities';
import type { QuietHours } from '../db/schema';
import { planSlots } from '../schedule/slots';

type Mix = Record<PostKind, number>;

/** The mix's kinds in posting order: videos and images spread through the week, not bunched at the end. */
export function spreadKinds(mix: Mix): PostKind[] {
  const n = Math.max(0, mix.text) + Math.max(0, mix.image) + Math.max(0, mix.video);
  const out: PostKind[] = Array(n).fill('text');
  const place = (kind: PostKind, count: number, offset: number) => {
    for (let j = 0; j < count; j++) {
      let i = Math.min(n - 1, Math.floor(((j + offset) * n) / count));
      while (out[i] !== 'text') i = (i + 1) % n;
      out[i] = kind;
    }
  };
  place('video', Math.max(0, mix.video), 0.5);
  place('image', Math.max(0, mix.image), 0.2);
  return out;
}

/**
 * Where the posts still missing from `mix` would land: the same slot picker
 * the planner uses (lib/schedule/slots.ts), minus times already taken. A fixed
 * `rand` keeps the projection still while the user tweaks settings; the real
 * plan picks its own times.
 */
export function projectWeek(opts: { from: Date; mix: Mix; have?: Partial<Mix>; taken?: Date[]; quiet?: QuietHours | null; horizonDays?: number }): { at: Date; kind: PostKind }[] {
  const missing: Mix = {
    text: Math.max(0, opts.mix.text - (opts.have?.text ?? 0)),
    image: Math.max(0, opts.mix.image - (opts.have?.image ?? 0)),
    video: Math.max(0, opts.mix.video - (opts.have?.video ?? 0)),
  };
  const kinds = spreadKinds(missing);
  if (!kinds.length) return [];
  const slots = planSlots({ from: opts.from, horizonDays: opts.horizonDays ?? 7, count: kinds.length, quiet: opts.quiet, taken: opts.taken ?? [], rand: () => 0.5 });
  return slots.map((at, i) => ({ at, kind: kinds[i] }));
}

/** Seven local-midnight days starting with `from`'s day. */
export function weekDays(from: Date): Date[] {
  const d0 = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  return Array.from({ length: 7 }, (_, i) => new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + i));
}

/** Which of `days` a time falls on (clamped: a slot just past the window sits on the last day). */
export function dayIndex(at: Date, days: Date[]): number {
  // Compare against each local midnight rather than dividing by 24h, so a DST day can't shift a slot.
  return days.reduce((idx, d, i) => (at >= d ? i : idx), 0);
}
