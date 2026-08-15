import type { QuietHours } from '../db/schema';

const BUSINESS_WINDOWS = [
  [9, 11],   // morning
  [12, 13],  // lunch
  [16, 18],  // afternoon
];

function inQuiet(d: Date, quiet: QuietHours | null | undefined): boolean {
  if (!quiet) return false;
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const [sh, sm] = quiet.start.split(':').map(Number);
  const [eh, em] = quiet.end.split(':').map(Number);
  const start = sh + sm / 60;
  const end = eh + em / 60;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

// Pick a near-future business-hours slot, jittered to avoid bursts.
export function nextPostingWindow(now: Date, quiet?: QuietHours | null): Date {
  const candidate = new Date(now.getTime() + 60 * 60 * 1000); // 1h from now baseline
  // 48 half-hour steps = a full day of candidates, so a legal slot is always
  // found when one exists. (24 covered only 12h: a run starting mid-afternoon
  // could walk past every remaining window and fall through to the raw
  // candidate — inside quiet hours.)
  const legal = (d: Date) => {
    const hour = d.getUTCHours();
    return BUSINESS_WINDOWS.some(([s, e]) => hour >= s && hour < e) && !inQuiet(d, quiet);
  };

  // Best slot we could fall back to if no business window is reachable: the
  // earliest candidate that at least isn't inside quiet hours.
  let firstNonQuiet: Date | null = null;

  for (let attempt = 0; attempt < 48; attempt++) {
    // Jitter FIRST, then validate. Jittering after the check moved the slot up
    // to ±25 minutes past a boundary and landed inside quiet hours about half
    // the time — the whole point of quiet hours is that nothing posts there.
    const jittered = new Date(candidate.getTime() + (Math.random() - 0.5) * 50 * 60 * 1000);
    if (legal(jittered)) return jittered;
    // Jitter pushed a legal slot out of bounds. Keep the slot, drop the jitter:
    // bursting slightly is a cosmetic problem, posting inside someone's quiet
    // hours is a broken promise.
    if (legal(candidate)) return new Date(candidate);
    if (!firstNonQuiet && !inQuiet(candidate, quiet)) firstNonQuiet = new Date(candidate);
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 30);
  }

  // No business window in the next 24h escapes the user's quiet hours (they can
  // cover all three). Quiet hours are an explicit instruction; business windows
  // are our preference, so the instruction wins. Only if literally every
  // candidate is quiet — a 24h quiet range — do we return the raw candidate.
  return firstNonQuiet ?? candidate;
}
