import { describe, it, expect } from 'vitest';
import { videoDurationSec } from './probe';

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
