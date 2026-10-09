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

// =====================================================
// Still-image probe
// =====================================================

export type ImageFormat = 'png' | 'jpeg' | 'webp';

/**
 * Container format from the leading magic bytes, or null.
 *
 * A `content-type` header is attacker-controlled, so anything we hand to an
 * image provider is identified from the bytes instead.
 */
export function imageFormat(buf: Buffer): ImageFormat | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/**
 * Pixel dimensions read from the header, or null when they can't be found.
 * PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X — no decode, no dependency.
 *
 * ponytail: ignores JPEG EXIF orientation (a rotated phone photo reports its
 * stored, not displayed, dimensions). Only the mask check reads this, and a mask
 * is built against the canvas the caller exported; add EXIF if that changes.
 */
export function imageDimensions(buf: Buffer): { width: number; height: number } | null {
  const fmt = imageFormat(buf);
  if (fmt === 'png') {
    if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (fmt === 'jpeg') {
    let off = 2;
    while (off + 9 <= buf.length) {
      if (buf[off] !== 0xff) return null;
      const m = buf[off + 1];
      if (m === 0xff) { off += 1; continue; } // fill byte
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { off += 2; continue; } // no length field
      if (m === 0xd9 || m === 0xda) return null; // image data before any frame header
      // SOF0–SOF15, minus DHT (C4), JPG (C8) and DAC (CC), which share the range.
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + buf.readUInt16BE(off + 2);
    }
    return null;
  }
  if (fmt === 'webp' && buf.length >= 30) {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}
