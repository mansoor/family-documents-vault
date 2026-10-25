import { deflateSync } from 'node:zlib';

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

/**
 * A PDF of one page per JPEG given, each page the picture drawn whole and
 * kept as it is — a DCTDecode image, as a scanning app keeps a page — so
 * poppler hands its bytes to libjpeg to draw (L2). `components` names its
 * colour space (1 grey, 3 RGB, 4 CMYK); each page is A4 unless `size` says
 * otherwise (points). `text` is a line of the page's own, in Helvetica.
 * As a hostile PDF may keep it: `claims` a size in its dictionary other
 * than the JPEG's own; `as` 'flate', its stream deflated as well
 * ([/FlateDecode /DCTDecode]); 'inline', in the page's content (BI … ID …
 * EI) rather than an object of its own; 'pattern', only inside a tiling
 * pattern the page is filled with; 'type3', only inside the one glyph of a
 * Type 3 font the page shows; `draws`, drawn that many times. `place` draws
 * it that many points across and up, from the corner.
 * For tests only.
 */
export function pdfOfJpegs(
  pages: Array<{
    jpeg: Buffer;
    width: number;
    height: number;
    components: 1 | 3 | 4;
    text?: string;
    size?: [number, number];
    claims?: [number, number];
    as?: 'xobject' | 'flate' | 'inline' | 'pattern' | 'type3';
    draws?: number;
    place?: [number, number];
  }>,
): Buffer {
  const objects: Buffer[] = [];
  const add = (body: Buffer | string) => {
    objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
    return objects.length;
  };
  const stream = (dict: string, data: Buffer) =>
    Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
      data,
      Buffer.from('\nendstream', 'latin1'),
    ]);
  const space = { 1: 'DeviceGray', 3: 'DeviceRGB', 4: 'DeviceCMYK' } as const;
  // 1 the catalog, 2 the pages (written last), 3 the font; each page's three after.
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const p of pages) {
    const [pw, ph] = p.size ?? [595, 842];
    const [w, h] = p.claims ?? [p.width, p.height];
    const [iw, ih] = p.place ?? [pw, ph];
    const inline = p.as === 'inline';
    const image = inline
      ? add('<< >>')
      : add(
          stream(
            `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /${space[p.components]} /BitsPerComponent 8 /Filter ${p.as === 'flate' ? '[/FlateDecode /DCTDecode]' : '/DCTDecode'}`,
            p.as === 'flate' ? deflateSync(p.jpeg) : p.jpeg,
          ),
        );
    const words = p.text
      ? `BT /F1 14 Tf 40 ${ph - 60} Td (${p.text.replace(/[()\\]/g, '\\$&')}) Tj ET\n`
      : '';
    // Drawn only inside a tiling pattern the page is filled with, or a Type 3
    // glyph it shows: places pdfimages does not look, and pdftoppm draws.
    const once = Buffer.from(`q ${iw} 0 0 ${ih} 0 0 cm /Im0 Do Q`, 'latin1');
    const holder =
      p.as === 'pattern'
        ? add(
            stream(
              `/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 ${pw} ${ph}] /XStep ${pw} /YStep ${ph} /Resources << /XObject << /Im0 ${image} 0 R >> >>`,
              once,
            ),
          )
        : p.as === 'type3'
          ? add(
              `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 ${pw} ${ph}] /FontMatrix [1 0 0 1 0 0] /CharProcs << /a ${objects.length + 2} 0 R >> /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [${pw}] /Resources << /XObject << /Im0 ${image} 0 R >> >> >>`,
            )
          : 0;
    if (p.as === 'type3') {
      add(stream('', Buffer.concat([Buffer.from(`${pw} 0 d0 `, 'latin1'), once])));
    }
    const resources =
      p.as === 'pattern'
        ? `/Pattern << /P0 ${holder} 0 R >> /Font << /F1 3 0 R >>`
        : p.as === 'type3'
          ? `/Font << /F1 3 0 R /T3 ${holder} 0 R >>`
          : `/XObject << /Im0 ${image} 0 R >> /Font << /F1 3 0 R >>`;
    const draw =
      p.as === 'pattern'
        ? Buffer.from(`q /Pattern cs /P0 scn 0 0 ${pw} ${ph} re f Q\n`, 'latin1')
        : p.as === 'type3'
          ? Buffer.from('BT /T3 1 Tf 0 0 Td (a) Tj ET\n', 'latin1')
          : inline
            ? Buffer.concat([
                Buffer.from(
                  `q ${iw} 0 0 ${ih} 0 0 cm\nBI /W ${w} /H ${h} /CS /${{ 1: 'G', 3: 'RGB', 4: 'CMYK' }[p.components]} /BPC 8 /F /DCT ID `,
                  'latin1',
                ),
                p.jpeg,
                Buffer.from('\nEI Q\n', 'latin1'),
              ])
            : Buffer.from(`q ${iw} 0 0 ${ih} 0 0 cm /Im0 Do Q\n`.repeat(p.draws ?? 1), 'latin1');
    const content = add(stream('', Buffer.concat([draw, Buffer.from(words, 'latin1')])));
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << ${resources} >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[1] = Buffer.from(
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`,
    'latin1',
  );
  const head = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const parts: Buffer[] = [head];
  let at = head.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(at);
    const obj = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(obj);
    at += obj.length;
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(at),
    '%%EOF',
    '',
  ].join('\n');
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}
