/** Where to park the player for a segment: 40% in shows a representative frame (AI motion starts from an empty background). */
export function segmentSeekSec(startSec: number, endSec: number): number {
  const len = Math.max(0, endSec - startSec);
  return Math.max(startSec, Math.min(startSec + len * 0.4, endSec - 0.05));
}

/** Representative paused frame for a video whose kind we can't know: AI motion graphics (short) open on an empty background and cross-fade mid-way, so park on the end card (0.8 s before the end, same frame the worker uses for posters); long footage is fine ~1 s in. */
export function posterSeekSec(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return durationSec <= 20 ? Math.max(0, durationSec - 0.8) : 1;
}

/** Park a paused video on its representative frame. Idempotent, so it can be wired to loadedmetadata, loadeddata and mount. */
export function seekToPoster(e: { currentTarget: HTMLVideoElement }): void {
  const v = e.currentTarget;
  const t = posterSeekSec(v.duration);
  if (t > 0 && Math.abs(v.currentTime - t) > 0.05) v.currentTime = t;
}
