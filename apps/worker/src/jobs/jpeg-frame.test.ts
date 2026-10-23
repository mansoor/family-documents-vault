import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wholeBufferJpeg } from './jpeg-test-helper.js';
import {
  JPEG_HEADER_MAX_BYTES,
  JPEG_HELD_MAX_COEFFICIENTS,
  jpegFrameOf,
  PictureRefused,
  refuseHeldJpeg,
} from './tools.js';

/**
 * The JPEG check (0.9.0, R3, round four): read from at most
 * JPEG_HEADER_MAX_BYTES of a file's start, in one synchronous pass, and
 * failing closed — a JPEG whose header it cannot read is refused, never
 * handed to libjpeg to hold whole. Needs no tools.
 */

const SOI = [0xff, 0xd8];
/** A segment: its marker, its length, its body. */
const seg = (marker: number, body: number[] | Buffer) => {
  const b = Buffer.alloc(4);
  b.writeUInt16BE(marker, 0);
  b.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([b, Buffer.from(body)]);
};
/** A frame (SOF2), `w` by `h`, `comps` components at 1×1. */
const sof = (w: number, h: number, comps: number, marker = 0xffc2) =>
  seg(marker, [
    8,
    h >> 8,
    h & 0xff,
    w >> 8,
    w & 0xff,
    comps,
    ...Array.from({ length: comps }, (_, c) => [c + 1, 0x11, 0]).flat(),
  ]);
const sos = (comps: number) =>
  seg(0xffda, [comps, ...Array.from({ length: comps }, (_, c) => [c + 1, 0]).flat(), 0, 63, 0]);

describe('the JPEG check (R3, round four)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-jpeg-frame-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const file = async (name: string, bytes: Buffer) => {
    const f = path.join(dir, name);
    await writeFile(f, bytes);
    return f;
  };
  /** Refused, as PictureRefused, in well under a second. */
  const refusedFast = async (f: string) => {
    const started = Date.now();
    await expect(refuseHeldJpeg(f), path.basename(f)).rejects.toBeInstanceOf(PictureRefused);
    expect(Date.now() - started, path.basename(f)).toBeLessThan(500);
  };

  it('reads past 100,001 empty segments to a progressive CMYK frame 8,000 square, and refuses it', async () => {
    const bytes = wholeBufferJpeg(8_000, 8_000, 4, 'progressive', { appSegments: 100_001 });
    expect(jpegFrameOf(bytes)).toEqual({
      width: 8_000,
      height: 8_000,
      coefficients: 256_000_000,
      held: true,
    });
    await refusedFast(await file('app-segments.jpg', bytes));
  });

  it('refuses a JPEG whose header it cannot read: it fails closed', async () => {
    const shapes: Record<string, Buffer> = {
      // Cut off in its tables.
      truncated: Buffer.from([...SOI, 0xff, 0xdb, 0x00, 0x43, 0x00, 1, 1]),
      // A scan before any frame.
      'scan-first': Buffer.concat([Buffer.from(SOI), sos(3), sof(100, 100, 3)]),
      // A frame of no height (a DNL marker's).
      'no-height': Buffer.concat([Buffer.from(SOI), sof(8_000, 0, 4), sos(1)]),
      // A segment whose length is under two.
      'short-length': Buffer.from([
        ...SOI,
        0xff,
        0xe1,
        0x00,
        0x01,
        ...new Array<number>(64).fill(0),
      ]),
      // A second SOI, or an EOI, before the scan.
      'second-soi': Buffer.from([...SOI, ...SOI]),
      'eoi-first': Buffer.from([...SOI, 0xff, 0xd9]),
      // Two frames.
      'two-frames': Buffer.concat([
        Buffer.from(SOI),
        sof(100, 100, 1),
        sof(9_000, 9_000, 4),
        sos(1),
      ]),
      // Nothing but fill bytes, then the end of the file.
      fill: Buffer.concat([Buffer.from(SOI), Buffer.alloc(4_096, 0xff)]),
    };
    for (const [name, bytes] of Object.entries(shapes)) {
      expect(jpegFrameOf(bytes), name).toBe('unknown');
      await refusedFast(await file(`${name}.jpg`, bytes));
    }
  });

  it('reads no more than JPEG_HEADER_MAX_BYTES: a header longer is refused, and 100 MB of junk after SOI in well under a second', async () => {
    // Thirty-three segments of 64 KB of a camera's metadata, then a small one-scan frame.
    const app = seg(0xffe1, Buffer.alloc(65_533));
    const long = Buffer.concat([
      Buffer.from(SOI),
      ...Array.from({ length: 33 }, () => app),
      sof(100, 100, 1, 0xffc0),
      sos(1),
    ]);
    expect(long.length).toBeGreaterThan(JPEG_HEADER_MAX_BYTES);
    // Whole, it is a small one-scan JPEG; its first 2 MiB cannot say so.
    expect(jpegFrameOf(long)).toMatchObject({ held: false });
    await refusedFast(await file('long-header.jpg', long));
    // SOI, then a hundred megabytes of nothing (a sparse file).
    const junk = path.join(dir, 'junk.jpg');
    const fh = await open(junk, 'w');
    await fh.write(Buffer.from(SOI), 0, 2, 0);
    await fh.truncate(100 * 1024 * 1024);
    await fh.close();
    await refusedFast(junk);
  });

  it('passes what it can read and libjpeg need not hold whole, and what is no JPEG at all', async () => {
    // At the most it may hold: 4,000 square in CMYK, progressive.
    const most = wholeBufferJpeg(4_000, 4_000, 4);
    expect(jpegFrameOf(most)).toMatchObject({ coefficients: JPEG_HELD_MAX_COEFFICIENTS });
    await expect(refuseHeldJpeg(await file('most.jpg', most))).resolves.toBeUndefined();
    // One scan, however big: libjpeg holds a row of blocks at a time.
    const one = wholeBufferJpeg(12_000, 12_000, 1, 'sequential');
    expect(jpegFrameOf(one)).toMatchObject({ held: false });
    await expect(refuseHeldJpeg(await file('one-scan.jpg', one))).resolves.toBeUndefined();
    // Bytes between markers passed over, as libjpeg passes over them.
    const junky = Buffer.concat([
      Buffer.from(SOI),
      Buffer.from('junk'),
      sof(100, 100, 1, 0xffc0),
      sos(1),
    ]);
    expect(jpegFrameOf(junky)).toMatchObject({ width: 100, held: false });
    // Not a JPEG: libjpeg will not decode it, and it is not this check's to refuse.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(jpegFrameOf(png)).toBeNull();
    await expect(refuseHeldJpeg(await file('not.jpg', png))).resolves.toBeUndefined();
  });

  it('takes a few milliseconds at worst, at its cap: one pass, a byte at least a step', () => {
    const worst = {
      'fill bytes': Buffer.concat([
        Buffer.from(SOI),
        Buffer.alloc(JPEG_HEADER_MAX_BYTES - 2, 0xff),
      ]),
      'junk bytes': Buffer.concat([
        Buffer.from(SOI),
        Buffer.alloc(JPEG_HEADER_MAX_BYTES - 2, 0x41),
      ]),
      'empty segments': Buffer.concat([
        Buffer.from(SOI),
        Buffer.alloc(JPEG_HEADER_MAX_BYTES - 2).fill(Buffer.from([0xff, 0xef, 0x00, 0x02])),
      ]),
    };
    for (const [name, head] of Object.entries(worst)) {
      const started = performance.now();
      expect(jpegFrameOf(head), name).toBe('unknown');
      expect(performance.now() - started, name).toBeLessThan(250);
    }
  });
});
