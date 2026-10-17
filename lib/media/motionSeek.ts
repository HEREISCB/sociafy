/** Where to park the player for a segment: 40% in shows a representative frame (AI motion starts from an empty background). */
export function segmentSeekSec(startSec: number, endSec: number): number {
  const len = Math.max(0, endSec - startSec);
  return Math.max(startSec, Math.min(startSec + len * 0.4, endSec - 0.05));
}
