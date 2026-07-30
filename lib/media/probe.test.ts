import { describe, it, expect } from 'vitest';
import { imageFormat, videoDurationSec } from './probe';

/** Minimal ISO-BMFF box builder — enough to exercise the atom walk. */
function box(type: string, body: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}

/** 64-bit-size box (`size == 1`, real size in the largesize field). */
function bigBox(type: string, body: Buffer): Buffer {
  const h = Buffer.alloc(16);
  h.writeUInt32BE(1, 0);
  h.write(type, 4, 'latin1');
  h.writeUInt32BE(0, 8);
  h.writeUInt32BE(16 + body.length, 12);
  return Buffer.concat([h, body]);
}

function mvhdV0(timescale: number, duration: number): Buffer {
  const b = Buffer.alloc(100); // real v0 mvhd payload length
  b[0] = 0;
  b.writeUInt32BE(timescale, 12);
  b.writeUInt32BE(duration, 16);
  return box('mvhd', b);
}

function mvhdV1(timescale: number, duration: number): Buffer {
  const b = Buffer.alloc(112);
  b[0] = 1;
  b.writeUInt32BE(timescale, 20);
  b.writeUInt32BE(0, 24); // duration high word
  b.writeUInt32BE(duration, 28);
  return box('mvhd', b);
}

const ftyp = box('ftyp', Buffer.from('isomiso2avc1mp41', 'latin1'));

describe('videoDurationSec (mvhd parser)', () => {
  it('reads a version-0 mvhd', () => {
    const buf = Buffer.concat([ftyp, box('moov', mvhdV0(600, 6_000))]);
    expect(videoDurationSec(buf)).toBe(10);
  });

  it('reads a version-1 mvhd (64-bit times)', () => {
    const buf = Buffer.concat([ftyp, box('moov', mvhdV1(1_000, 12_500))]);
    expect(videoDurationSec(buf)).toBe(12.5);
  });

  it('finds moov when it sits AFTER mdat', () => {
    const mdat = box('mdat', Buffer.alloc(4_096, 7));
    const buf = Buffer.concat([ftyp, mdat, box('moov', mvhdV0(30_000, 900_000))]);
    expect(videoDurationSec(buf)).toBe(30);
  });

  it('skips a 64-bit-size mdat to reach a trailing moov', () => {
    const buf = Buffer.concat([
      ftyp,
      bigBox('mdat', Buffer.alloc(2_048, 3)),
      box('moov', mvhdV0(1_000, 5_500)),
    ]);
    expect(videoDurationSec(buf)).toBe(5.5);
  });

  it('ignores sibling boxes inside moov and still finds mvhd', () => {
    const moov = box('moov', Buffer.concat([
      box('udta', Buffer.alloc(64, 1)),
      mvhdV0(1_000, 8_000),
      box('trak', Buffer.alloc(128, 2)),
    ]));
    expect(videoDurationSec(Buffer.concat([ftyp, moov]))).toBe(8);
  });

  it('returns null for a non-video buffer', () => {
    expect(videoDurationSec(Buffer.from('not a video at all, just text bytes'))).toBeNull();
    expect(videoDurationSec(Buffer.alloc(0))).toBeNull();
    expect(videoDurationSec(Buffer.alloc(64))).toBeNull(); // all zeroes: size 0 box, no moov
    // WebM/Matroska is not ISO-BMFF — unknown, never guessed.
    expect(videoDurationSec(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
  });

  it('returns null when the buffer is truncated mid-moov', () => {
    const full = Buffer.concat([ftyp, box('moov', mvhdV0(600, 6_000))]);
    expect(videoDurationSec(full.subarray(0, ftyp.length + 12))).toBeNull();
  });

  it('returns null for a fragmented MP4 (mvhd duration 0)', () => {
    const buf = Buffer.concat([ftyp, box('moov', mvhdV0(1_000, 0))]);
    expect(videoDurationSec(buf)).toBeNull();
  });

  it('returns null for the 0xffffffff "unknown duration" sentinel', () => {
    const buf = Buffer.concat([ftyp, box('moov', mvhdV0(1_000, 0xffffffff))]);
    expect(videoDurationSec(buf)).toBeNull();
  });

  it('returns null when timescale is zero (would divide by zero)', () => {
    const buf = Buffer.concat([ftyp, box('moov', mvhdV0(0, 6_000))]);
    expect(videoDurationSec(buf)).toBeNull();
  });
});

// =====================================================
// Still images — the format sniff is what stops a caller's content-type header
// from deciding what we hand to the image provider.
// =====================================================

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  PNG_SIG.copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** SOI, an APP0 segment (so the walk has to skip one), then SOFn. */
function jpeg(width: number, height: number, sof = 0xc0): Buffer {
  const app0 = Buffer.alloc(18);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  app0.write('JFIF\0', 4, 'latin1');
  const frame = Buffer.alloc(11);
  frame.writeUInt16BE(0xff00 | sof, 0);
  frame.writeUInt16BE(9, 2); // length: precision + h + w + 1 component
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame]);
}

function riff(chunk: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(12 + payload.length, 4);
  head.write('WEBP', 8, 'latin1');
  head.write(chunk, 12, 'latin1');
  head.writeUInt32LE(payload.length, 16);
  return Buffer.concat([head, payload, Buffer.alloc(16)]); // pad: real files continue
}

function webpLossy(width: number, height: number): Buffer {
  const p = Buffer.alloc(10);
  p.writeUInt8(0x9d, 3);
  p.writeUInt8(0x01, 4);
  p.writeUInt8(0x2a, 5);
  p.writeUInt16LE(width, 6);
  p.writeUInt16LE(height, 8);
  return riff('VP8 ', p);
}

describe('imageFormat (magic bytes)', () => {
  it('identifies the three formats we accept', () => {
    expect(imageFormat(png(1, 1))).toBe('png');
    expect(imageFormat(jpeg(1, 1))).toBe('jpeg');
    expect(imageFormat(webpLossy(1, 1))).toBe('webp');
  });

  it('is not fooled by a container we do not accept', () => {
    expect(imageFormat(Buffer.from('GIF89a...........', 'latin1'))).toBeNull();
    expect(imageFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    // RIFF, but a WAV rather than a WEBP.
    expect(imageFormat(Buffer.from('RIFF....WAVEfmt ', 'latin1'))).toBeNull();
    expect(imageFormat(Buffer.alloc(0))).toBeNull();
  });
});
