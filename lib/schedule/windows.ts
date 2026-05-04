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
  for (let attempt = 0; attempt < 24; attempt++) {
    const hour = candidate.getUTCHours();
    const inWindow = BUSINESS_WINDOWS.some(([s, e]) => hour >= s && hour < e);
    if (inWindow && !inQuiet(candidate, quiet)) {
      // jitter ±25 minutes
      const jitterMs = (Math.random() - 0.5) * 50 * 60 * 1000;
      return new Date(candidate.getTime() + jitterMs);
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 30);
  }
  return candidate;
}
