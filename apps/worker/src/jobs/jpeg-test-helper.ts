/**
 * A JPEG of nothing that libjpeg must hold whole (the R3 re-check, F1), of
 * any size and any number of components, a few megabytes long: every
 * coefficient zero, in more than one scan — `progressive` (SOF2: a DC scan
 * of one bit a block, then each component's AC scan, a run of end-of-bands)
 * or `sequential` (SOF0, a baseline JPEG, but each component in a scan of
 * its own: two bits a block; of one component, an ordinary one-scan
 * baseline JPEG, never held whole). Small to send and to store, but a decoder
 * keeps every coefficient of a JPEG in more than one scan until its last —
 * 16,000 pixels square in CMYK is two gigabytes — whatever size it is asked
 * to decode it at. `appSegments` APP15 segments come first, each `appSize` bytes of
 * nothing (none by default). For tests only.
 */
export function wholeBufferJpeg(
  width: number,
  height: number,
  components: 1 | 3 | 4,
  scans: 'progressive' | 'sequential' = 'progressive',
  opts: { appSegments?: number; appSize?: number } = {},
): Buffer {
  const parts: Buffer[] = [];
  const seg = (marker: number, body: number[] | Buffer) => {
    const b = Buffer.alloc(4);
    b.writeUInt16BE(marker, 0);
    b.writeUInt16BE(body.length + 2, 2);
    parts.push(b, Buffer.from(body));
  };
  const zeros = (n: number) => Array.from({ length: n }, () => 0);
  parts.push(Buffer.from([0xff, 0xd8]));
  // APP15 segments before anything else (round four), their bodies nothing:
  // libjpeg passes over every one.
  if (opts.appSegments) {
    const size = opts.appSize ?? 0;
    const app = Buffer.alloc(4 + size);
    app.set([0xff, 0xef, (size + 2) >> 8, (size + 2) & 0xff]);
    parts.push(Buffer.alloc(opts.appSegments * app.length).fill(app));
  }
  // One quantisation table of ones.
  seg(0xffdb, [0, ...Array.from({ length: 64 }, () => 1)]);
  // SOF2 or SOF0: 8 bits, each component 1×1, table 0.
  const sof = [8, height >> 8, height & 0xff, width >> 8, width & 0xff, components];
  for (let c = 0; c < components; c += 1) sof.push(c + 1, 0x11, 0);
  seg(scans === 'progressive' ? 0xffc2 : 0xffc0, sof);
  const blocksPer = Math.ceil(width / 8) * Math.ceil(height / 8);

  if (scans === 'sequential') {
    // DC table 0: one one-bit code, "0", for no difference (libjpeg refuses
    // an all-ones code); AC table 0: one one-bit code, "0", end of block.
    seg(0xffc4, [0x00, 1, ...zeros(15), 0, 0x10, 1, ...zeros(15), 0x00]);
    // Each component a scan of its own: two "0" bits a block.
    for (let c = 0; c < components; c += 1) {
      seg(0xffda, [1, c + 1, 0x00, 0, 63, 0]);
      parts.push(Buffer.alloc(Math.ceil((blocksPer * 2) / 8)));
    }
    parts.push(Buffer.from([0xff, 0xd9]));
    return Buffer.concat(parts);
  }

  // DC table 0 as above; AC table 0: EOB0 to EOB14, fifteen four-bit codes.
  const acBits = [0, 0, 0, 15, ...zeros(12)];
  const eob = Array.from({ length: 15 }, (_, n) => n << 4);
  seg(0xffc4, [0x00, 1, ...zeros(15), 0, 0x10, ...acBits, ...eob]);
  // The DC scan, every component interleaved: a "0" bit a block.
  const dcSos: number[] = [components];
  for (let c = 0; c < components; c += 1) dcSos.push(c + 1, 0x00);
  dcSos.push(0, 0, 0);
  seg(0xffda, dcSos);
  parts.push(Buffer.alloc(Math.ceil((blocksPer * components) / 8)));
  // Each component's AC scan: its blocks in runs of end-of-band.
  for (let c = 0; c < components; c += 1) {
    seg(0xffda, [1, c + 1, 0x00, 1, 63, 0]);
    const out: number[] = [];
    let acc = 0;
    let nbits = 0;
    const put = (code: number, len: number) => {
      for (let i = len - 1; i >= 0; i -= 1) {
        acc = (acc << 1) | ((code >> i) & 1);
        nbits += 1;
        if (nbits === 8) {
          out.push(acc);
          if (acc === 0xff) out.push(0);
          acc = 0;
          nbits = 0;
        }
      }
    };
    let left = blocksPer;
    while (left > 0) {
      const run = Math.min(left, 32767);
      const n = Math.floor(Math.log2(run));
      put(n, 4); // EOBn's code is n, four bits
      if (n > 0) put(run - (1 << n), n);
      left -= run;
    }
    if (nbits > 0) put((1 << (8 - nbits)) - 1, 8 - nbits);
    parts.push(Buffer.from(out));
  }
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}
