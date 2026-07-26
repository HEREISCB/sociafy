/**
 * Duration probe for uploaded video, with no ffmpeg and no new dependency.
 *
 * We only need one number (seconds) and only for billing, so we read it
 * straight out of the ISO-BMFF box tree: `moov` → `mvhd` carries a timescale
 * and a duration. Boxes are length-prefixed, so walking siblings by size
 * handles any ordering (`moov` legally sits after `mdat` in streaming-oriented
 * files) without assuming layout.
 *
 * ponytail: ISO-BMFF only (MP4/M4V/MOV). WebM returns null and callers must
 * treat null as "unknown" — add an EBML branch if browser-recorded WebM
 * reference clips become common.
 */

/** Walk sibling boxes at the top of `buf`, returning `type`'s payload. */
function findBox(buf: Buffer, type: string): Buffer | null {
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const kind = buf.toString('latin1', off + 4, off + 8);
    let body = off + 8;
    if (size === 1) {
      // 64-bit largesize. Anything we accept is under the 50MB upload cap, so a
      // non-zero high word means this isn't a file we should be parsing.
      if (off + 16 > buf.length || buf.readUInt32BE(off + 8) !== 0) return null;
      size = buf.readUInt32BE(off + 12);
      body = off + 16;
    } else if (size === 0) {
      size = buf.length - off; // "extends to end of file"
    }
    // Size smaller than its own header = garbage (or a non-MP4 buffer we're
    // misreading). Bail rather than loop forever on a zero-length step.
    if (size < body - off) return null;
    if (kind === type) return buf.subarray(body, Math.min(off + size, buf.length));
    off += size;
  }
  return null;
}

/**
 * Video duration in seconds, or null when it genuinely can't be determined
 * (not ISO-BMFF, truncated, or a fragmented MP4 whose mvhd duration is 0).
 * Never guesses — callers on a money path must fail closed on null.
 */
export function videoDurationSec(buf: Buffer): number | null {
  const moov = findBox(buf, 'moov');
  if (!moov) return null;
  const mvhd = findBox(moov, 'mvhd');
  if (!mvhd || mvhd.length < 20) return null;

  let timescale: number;
  let duration: number;
  if (mvhd[0] === 1) {
    // v1: 8-byte creation/modification, 4-byte timescale, 8-byte duration.
    if (mvhd.length < 32) return null;
    timescale = mvhd.readUInt32BE(20);
    if (mvhd.readUInt32BE(24) !== 0) return null; // >2^32 ticks: absurd, not ours
    duration = mvhd.readUInt32BE(28);
  } else {
    // v0: 4-byte creation/modification, timescale, duration.
    timescale = mvhd.readUInt32BE(12);
    duration = mvhd.readUInt32BE(16);
  }

  // 0 / 0xffffffff both mean "unknown" — fragmented MP4 keeps the real length
  // in mvex/moof, which we don't parse. Report unknown, don't guess.
  if (!timescale || !duration || duration === 0xffffffff) return null;
  return duration / timescale;
}
