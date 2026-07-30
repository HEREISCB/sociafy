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
 * image provider (and price by its pixel count) is identified from the bytes.
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
 * Pixel dimensions of a PNG / JPEG / WebP buffer, or null when they cannot be
 * determined (wrong format, truncated header, an exotic WebP chunk layout).
 *
 * Same spirit as videoDurationSec above: these are billing inputs, so we read
 * them from the headers ourselves — no decoder, no new dependency — and never
 * guess. Callers on a money path must fail closed on null.
 */
export function imageDimensions(buf: Buffer): { width: number; height: number } | null {
  const fmt = imageFormat(buf);
  const dim =
    fmt === 'png' ? pngSize(buf) : fmt === 'jpeg' ? jpegSize(buf) : fmt === 'webp' ? webpSize(buf) : null;
  // 0 is as unusable as absent — it would price as free and can't be a real image.
  if (!dim || !dim.width || !dim.height) return null;
  return dim;
}

/** IHDR is mandated to be the first chunk, so its offsets are fixed. */
function pngSize(buf: Buffer) {
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Walk JPEG marker segments to the first SOFn (baseline, progressive, or any
 *  of the arithmetic/lossless variants) and read its frame header. */
function jpegSize(buf: Buffer) {
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null; // out of sync with the marker stream
    const marker = buf[off + 1];
    // Fill bytes (0xff padding) and standalone markers carry no length field.
    if (marker === 0xff) { off += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return null;
    // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc), which are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (off + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    // SOS: entropy-coded data follows, so there is no SOFn left to find.
    if (marker === 0xda) return null;
    off += 2 + len;
  }
  return null;
}

/** RIFF header is 12 bytes, then one 8-byte chunk header; the first chunk of a
 *  WebP is VP8 (lossy), VP8L (lossless) or VP8X (extended = canvas size). */
function webpSize(buf: Buffer) {
  if (buf.length < 30) return null;
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // 3-byte frame tag, 3-byte sync code, then 14-bit width and height.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // Canvas size, 24-bit little-endian, stored minus one.
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}
