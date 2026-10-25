import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractText } from './extract-text.js';
import { pdfOfJpegs, wholeBufferJpeg } from './jpeg-test-helper.js';
import {
  detectTools,
  JPEG_HEADER_MAX_BYTES,
  PDF_CHECK_MAX_BYTES,
  PDF_LIST_MAX_BYTES,
  pdfJpegFrameOf,
  pdfJpegStart,
  pdfPictures,
  PictureRefused,
  POPPLER_MAX_KIB,
  popplerCommand,
  refusePdfHeldJpegs,
  renderPdfPage,
  renderPdfPages,
  renderPreviews,
  runTool,
  thumbnail,
} from './tools.js';

/**
 * JPEGs inside PDFs (0.9.0, L2): poppler draws them with libjpeg, which
 * holds a JPEG in more than one scan whole, as ImageMagick's does; so each
 * is held to the rule a photo's JPEG is (refuseHeldJpeg) before poppler
 * draws a page — read from its own bytes, whatever the PDF's dictionary
 * says — and every poppler run is capped. The real-tool tests need poppler
 * (and ImageMagick and Tesseract for the ordinary scans), and skip without.
 */

const tools = await detectTools();
const real = Boolean(tools.pdftoppm && tools.pdfimages && tools.magick);

describe('where poppler starts a JPEG in a PDF (L2)', () => {
  it('passes over what comes before, as poppler does, and not FF FF D8', () => {
    expect(pdfJpegStart(Buffer.from([0xff, 0xd8, 0xff]))).toBe(0);
    expect(pdfJpegStart(Buffer.from('junk\xff\xd8\xff', 'latin1'))).toBe(4);
    // An 0xFF after 0xFF starts the looking again: poppler finds the later start.
    expect(pdfJpegStart(Buffer.from([0xff, 0xff, 0xd8, 0, 0xff, 0xd8]))).toBe(4);
    expect(pdfJpegStart(Buffer.from([0x00, 0xff, 0x00, 0xd8]))).toBe(-1);
  });

  it('reads the frame from there, and fails closed where it cannot find one', () => {
    const bomb = wholeBufferJpeg(16_000, 16_000, 4);
    const behind = Buffer.concat([Buffer.from('%garbage before the picture\n'), bomb]);
    expect(pdfJpegFrameOf(behind, true)).toEqual({
      width: 16_000,
      height: 16_000,
      coefficients: 1_024_000_000,
      held: true,
    });
    // No start in the whole stream: poppler draws nothing of it.
    expect(pdfJpegFrameOf(Buffer.alloc(100), true)).toBeNull();
    // No start in what was read of a longer one: refused.
    expect(pdfJpegFrameOf(Buffer.alloc(100), false)).toBe('unknown');
  });

  it('reads pdfimages’ list, a row each time a picture is drawn', () => {
    const listed = [
      'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio',
      '--------------------------------------------------------------------------------------------',
      '   1     0 image     100   100  cmyk    4   8  jpeg   no         4  0    12     9 1955K 5005%',
      '   1     1 image   16000 16000  cmyk    4   8  jpeg   no   [inline]    1936  1368    0B 0.0%',
      '   2     2 smask    2480  3508  gray    1   8  image  no         9  0   300   300  12K 0.1%',
    ].join('\n');
    expect(pdfPictures(listed)).toEqual([
      { page: 1, width: 100, height: 100, components: 4, bits: 8, enc: 'jpeg' },
      { page: 1, width: 16_000, height: 16_000, components: 4, bits: 8, enc: 'jpeg' },
      { page: 2, width: 2480, height: 3508, components: 1, bits: 8, enc: 'image' },
    ]);
  });

  it('runs poppler capped on Linux, as it is elsewhere', () => {
    expect(popplerCommand('pdftoppm', ['-v'], {}, 'linux')).toEqual({
      bin: 'sh',
      args: ['-c', `ulimit -v ${POPPLER_MAX_KIB} && exec "$0" "$@"`, 'pdftoppm', '-v'],
    });
    expect(popplerCommand('pdfimages', ['-j'], { fileBlocks: 4096 }, 'linux').args[1]).toBe(
      `trap '' XFSZ && ulimit -f 4096 && ulimit -v ${POPPLER_MAX_KIB} && exec "$0" "$@"`,
    );
    expect(popplerCommand('pdftoppm', ['-v'], {}, 'win32')).toEqual({
      bin: 'pdftoppm',
      args: ['-v'],
    });
  });
});

describe.skipIf(!real)('JPEGs inside PDFs, with the real tools (L2)', () => {
  let dir: string;
  const bombs: Record<string, Buffer> = {};
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-pdf-jpegs-'));
    const prog16 = wholeBufferJpeg(16_000, 16_000, 4);
    type Page = Parameters<typeof pdfOfJpegs>[0][number];
    const one = (jpeg: Buffer, side: number, more: Partial<Page> = {}) =>
      pdfOfJpegs([{ jpeg, width: side, height: side, components: 4, ...more }]);
    // Each drew at 1.97 GiB, or 513 MiB, before L2 (measured: see docs/smart-exit.md).
    bombs['prog-16000-cmyk.pdf'] = one(prog16, 16_000);
    bombs['seq-16000-cmyk.pdf'] = one(wholeBufferJpeg(16_000, 16_000, 4, 'sequential'), 16_000);
    bombs['prog-8000-cmyk.pdf'] = one(wholeBufferJpeg(8_000, 8_000, 4), 8_000);
    // The dictionary says 100 pixels square.
    bombs['claims-100.pdf'] = one(prog16, 16_000, { claims: [100, 100] });
    // Deflated as well: 3 KB.
    bombs['flate.pdf'] = one(prog16, 16_000, { as: 'flate' });
    // In the page's content.
    bombs['inline.pdf'] = one(prog16, 16_000, { as: 'inline' });
    // Behind bytes poppler passes over.
    bombs['behind-junk.pdf'] = one(Buffer.concat([Buffer.from('junk junk\n'), prog16]), 16_000);
    // On page 2, after an ordinary page.
    bombs['page-2.pdf'] = pdfOfJpegs([
      { jpeg: wholeBufferJpeg(800, 800, 1, 'sequential'), width: 800, height: 800, components: 1 },
      { jpeg: prog16, width: 16_000, height: 16_000, components: 4 },
    ]);
    for (const [name, bytes] of Object.entries(bombs)) {
      await writeFile(path.join(dir, name), bytes);
    }
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Every file left in a folder, and in the folders in it. */
  const left = async (d: string): Promise<string[]> =>
    (await readdir(d, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name);

  it('a PDF holding a JPEG libjpeg would hold whole is refused by every path that draws it, at once, nothing left on disk', async () => {
    expect(bombs['flate.pdf']!.length).toBeLessThan(4_000);
    const paths = {
      'ocr page': (f: string, out: string) => renderPdfPage(f, out, 1),
      'ocr pages': (f: string, out: string) => renderPdfPages(f, out, 5),
      thumbnail: (f: string, out: string) => thumbnail(f, path.join(out, 'thumb.jpg')),
      previews: (f: string, out: string) => renderPreviews(f, 'application/pdf', out, 5),
    };
    for (const name of Object.keys(bombs)) {
      for (const [where, draw] of Object.entries(paths)) {
        // The page-2 bomb is not on the thumbnail's page, nor on OCR's page 1.
        if (name === 'page-2.pdf' && (where === 'thumbnail' || where === 'ocr page')) continue;
        const out = await mkdtemp(path.join(dir, 'out-'));
        const started = Date.now();
        await expect(draw(path.join(dir, name), out), `${where} ${name}`).rejects.toBeInstanceOf(
          PictureRefused,
        );
        expect(Date.now() - started, `${where} ${name}`).toBeLessThan(10_000);
        expect(await left(out), `${where} ${name}`).toEqual([]);
        await rm(out, { recursive: true, force: true });
      }
    }
    // Page 2's, drawn alone, refused too; its page 1 is drawn.
    const out = await mkdtemp(path.join(dir, 'out-'));
    await expect(renderPdfPage(path.join(dir, 'page-2.pdf'), out, 2)).rejects.toBeInstanceOf(
      PictureRefused,
    );
    expect(path.basename(await renderPdfPage(path.join(dir, 'page-2.pdf'), out, 1))).toBe(
      'page-1.png',
    );
  }, 300_000);

  it('a scan of one is refused before Tesseract is asked to read it: ocr says picture refused', async () => {
    for (const name of ['prog-16000-cmyk.pdf', 'claims-100.pdf', 'flate.pdf']) {
      const work = await mkdtemp(path.join(dir, 'read-'));
      const asked: string[] = [];
      const started = Date.now();
      await expect(
        extractText(path.join(dir, name), 'application/pdf', {
          maxPages: 5,
          workDir: work,
          tools: { ...tools, tesseract: true },
          ocr: async (image) => {
            asked.push(image);
            return '';
          },
        }),
        name,
      ).rejects.toMatchObject({ code: 'picture_refused' });
      expect(asked, name).toEqual([]);
      expect(Date.now() - started, name).toBeLessThan(10_000);
      expect(await left(work), name).toEqual([]);
    }
  }, 300_000);

  it('a page drawing more pictures than the check writes at once is refused (failing closed)', async () => {
    const small = wholeBufferJpeg(64, 64, 1, 'sequential');
    const draws = Math.floor(PDF_CHECK_MAX_BYTES / JPEG_HEADER_MAX_BYTES) + 1;
    const many = path.join(dir, 'many.pdf');
    await writeFile(
      many,
      pdfOfJpegs([{ jpeg: small, width: 64, height: 64, components: 1, draws }]),
    );
    await expect(refusePdfHeldJpegs(many, 1, 1, dir)).rejects.toThrow(/more pictures/);
    // One fewer is checked, and passes.
    await writeFile(
      many,
      pdfOfJpegs([{ jpeg: small, width: 64, height: 64, components: 1, draws: draws - 1 }]),
    );
    await expect(refusePdfHeldJpegs(many, 1, 1, dir)).resolves.toBeUndefined();
  }, 120_000);

  it('a PDF whose pictures cannot be listed is refused, not failed: failing, or a list cut off; one needing a password says so', async () => {
    // pdfimages fails on it (exit 1).
    const broken = path.join(dir, 'broken.pdf');
    await writeFile(broken, Buffer.from('%PDF-1.4\nnothing a PDF needs\n'));
    await expect(refusePdfHeldJpegs(broken, 1, 1, dir)).rejects.toBeInstanceOf(PictureRefused);
    await expect(renderPdfPage(broken, dir, 1)).rejects.toMatchObject({ code: 'picture_refused' });
    // A list past PDF_LIST_MAX_BYTES: a 16-pixel picture drawn 100,000 times (2.6 MB).
    const listed = path.join(dir, 'listed.pdf');
    const tiny = wholeBufferJpeg(16, 16, 1, 'sequential');
    await writeFile(
      listed,
      pdfOfJpegs([{ jpeg: tiny, width: 16, height: 16, components: 1, draws: 100_000 }]),
    );
    expect(100_000 * 90).toBeGreaterThan(PDF_LIST_MAX_BYTES);
    await expect(refusePdfHeldJpegs(listed, 1, 1, dir)).rejects.toThrow(/cannot list/);
    await rm(listed, { force: true });
    // Locked with a password (any: the vault tries none): said as before, not as a refusal.
    const plain = pdfOfJpegs([{ jpeg: tiny, width: 16, height: 16, components: 1 }]).toString(
      'latin1',
    );
    const locked = path.join(dir, 'locked.pdf');
    const hex32 = '11'.repeat(32);
    await writeFile(
      locked,
      Buffer.from(
        plain.replace(
          /\/Root 1 0 R >>/,
          `/Root 1 0 R /Encrypt << /Filter /Standard /V 1 /R 2 /O <${hex32}> /U <${hex32}> /P -4 >> /ID [<${'22'.repeat(16)}> <${'22'.repeat(16)}>] >>`,
        ),
        'latin1',
      ),
    );
    const err = await refusePdfHeldJpegs(locked, 1, 1, dir).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PictureRefused);
    expect(String((err as { stderr?: string }).stderr ?? (err as Error).message)).toMatch(
      /password/i,
    );
  }, 120_000);

  it.skipIf(process.platform !== 'linux')(
    'a poppler run is capped: a JPEG the check cannot see — under another filter, in a tiling pattern, in a Type 3 glyph — is drawn blank in no more than POPPLER_MAX_KIB',
    async () => {
      const prog16 = wholeBufferJpeg(16_000, 16_000, 4);
      const page = { jpeg: prog16, width: 16_000, height: 16_000, components: 4 as const };
      const unseen = {
        // pdfimages lists it as a plain picture; libjpeg holds it whole, 1,972 MiB uncapped.
        'dct-inner.pdf': Buffer.from(
          bombs['prog-16000-cmyk.pdf']!.toString('latin1').replace(
            '/Filter /DCTDecode',
            '/Filter [/DCTDecode /FlateDecode]',
          ),
          'latin1',
        ),
        // pdfimages lists nothing of either; pdftoppm draws them.
        'pattern.pdf': pdfOfJpegs([{ ...page, as: 'pattern' }]),
        'type3.pdf': pdfOfJpegs([{ ...page, as: 'type3' }]),
      };
      for (const [name, bytes] of Object.entries(unseen)) {
        const hidden = path.join(dir, name);
        await writeFile(hidden, bytes);
        await expect(refusePdfHeldJpegs(hidden, 1, 1, dir), name).resolves.toBeUndefined();
        const out = path.join(dir, 'hidden');
        const how = popplerCommand('pdftoppm', [
          '-png',
          '-r',
          '150',
          '-f',
          '1',
          '-l',
          '1',
          '-singlefile',
          hidden,
          out,
        ]);
        const child = spawn(how.bin, how.args, { stdio: 'ignore' });
        let peakKib = 0;
        const poll = setInterval(() => {
          readFile(`/proc/${child.pid}/status`, 'utf8')
            .then((s) => {
              const kib = Number(/VmPeak:\s+(\d+)/.exec(s)?.[1] ?? 0);
              peakKib = Math.max(peakKib, kib);
            })
            .catch(() => undefined);
        }, 10);
        const code = await new Promise((resolve) => child.on('exit', resolve));
        clearInterval(poll);
        // It went for the picture (far past what a blank page takes), and was held to the cap.
        expect(peakKib, name).toBeGreaterThan(256 * 1024);
        expect(peakKib, name).toBeLessThanOrEqual(POPPLER_MAX_KIB);
        // Silently: drawn, blank, exit 0 (a known limit: docs/smart-exit.md).
        expect(code, name).toBe(0);
        await rm(`${out}.png`, { force: true });
        await rm(hidden, { force: true });
      }

      // And what the check writes is cut off at JPEG_HEADER_MAX_BYTES a file:
      // this JPEG is 4 MB, and pdfimages carries on past it.
      const four = path.join(dir, 'seq-16000-cmyk.pdf');
      const into = await mkdtemp(path.join(dir, 'cut-'));
      const cut = popplerCommand('pdfimages', ['-j', four, path.join(into, 'p')], {
        fileBlocks: JPEG_HEADER_MAX_BYTES / 512,
      });
      await runTool(cut.bin, cut.args, { timeout: 60_000 });
      const [written] = await readdir(into);
      expect(written).toBe('p-000.jpg');
      expect((await readFile(path.join(into, written!))).length).toBe(JPEG_HEADER_MAX_BYTES);
      expect(bombs['seq-16000-cmyk.pdf']!.length).toBeGreaterThan(1.5 * JPEG_HEADER_MAX_BYTES);
    },
    120_000,
  );

  it('ordinary scanned PDFs still read, their previews and thumbnails made: baseline, progressive, CMYK, and a JPEG at the most held whole', async () => {
    const draw = async (name: string, args: string[]) => {
      const f = path.join(dir, name);
      await runTool('magick', [...args, `jpeg:${f}`], { timeout: 120_000 }).catch(() =>
        runTool('convert', [...args, `jpeg:${f}`], { timeout: 120_000 }),
      );
      return readFile(f);
    };
    const words = (w: number, h: number, pt: number) => [
      '-size',
      `${w}x${h}`,
      'xc:white',
      '-font',
      'DejaVu-Sans',
      '-fill',
      'black',
      '-pointsize',
      String(pt),
      '-annotate',
      `+${Math.round(w / 12)}+${Math.round(h / 8)}`,
      'Payment due by 29/04/2026',
    ];
    const scans = {
      // A phone scanning app's page: 300 dpi colour, baseline, 4:2:0.
      'a4-300-rgb.pdf': {
        jpeg: await draw('a.jpg', [
          ...words(2480, 3508, 60),
          '-type',
          'TrueColor',
          '-quality',
          '85',
        ]),
        width: 2480,
        height: 3508,
        components: 3 as const,
      },
      // 600 dpi colour, progressive, 4:2:0: 52 million coefficients, held whole.
      'a4-600-rgb-prog.pdf': {
        jpeg: await draw('b.jpg', [
          ...words(4960, 7016, 120),
          '-type',
          'TrueColor',
          '-interlace',
          'JPEG',
          '-sampling-factor',
          '4:2:0',
          '-quality',
          '85',
        ]),
        width: 4960,
        height: 7016,
        components: 3 as const,
      },
      // 300 dpi CMYK, baseline.
      'a4-300-cmyk.pdf': {
        jpeg: await draw('c.jpg', [
          ...words(2480, 3508, 60),
          '-colorspace',
          'CMYK',
          '-quality',
          '85',
        ]),
        width: 2480,
        height: 3508,
        components: 4 as const,
      },
    };
    for (const [name, page] of Object.entries(scans)) {
      const f = path.join(dir, name);
      await writeFile(f, pdfOfJpegs([page]));
      const work = await mkdtemp(path.join(dir, 'ok-'));
      const got = await extractText(f, 'application/pdf', { maxPages: 5, workDir: work });
      expect(got?.text, name).toMatch(/Payment due by 29\/04\/2026/);
      expect(got?.ocrPages, name).toBe(1);
      expect(await renderPreviews(f, 'application/pdf', work, 5), name).toHaveLength(1);
      await thumbnail(f, path.join(work, 'thumb.jpg'));
    }
    // A progressive CMYK JPEG 4,000 square: 64 million coefficients, the most held whole.
    const most = path.join(dir, 'most.pdf');
    await writeFile(
      most,
      pdfOfJpegs([
        { jpeg: wholeBufferJpeg(4_000, 4_000, 4), width: 4_000, height: 4_000, components: 4 },
      ]),
    );
    const out = await mkdtemp(path.join(dir, 'most-'));
    expect(await renderPreviews(most, 'application/pdf', out, 5)).toHaveLength(1);
    // A one-scan JPEG 16,000 square is never held: libjpeg streams it.
    const streamed = path.join(dir, 'streamed.pdf');
    await writeFile(
      streamed,
      pdfOfJpegs([
        {
          jpeg: wholeBufferJpeg(16_000, 16_000, 1, 'sequential'),
          width: 16_000,
          height: 16_000,
          components: 1,
        },
      ]),
    );
    expect(await renderPreviews(streamed, 'application/pdf', out, 5)).toHaveLength(1);
    // A PDF of text alone: read by its words, never drawn.
    const text = path.join(dir, 'text.pdf');
    await writeFile(
      text,
      pdfOfJpegs([
        {
          jpeg: wholeBufferJpeg(8, 8, 1, 'sequential'),
          width: 8,
          height: 8,
          components: 1,
          place: [20, 20],
          text: 'Policy number 998877, renewal due 01/02/2027, for Mrs Sara Khan of Leeds',
        },
      ]),
    );
    const got = await extractText(text, 'application/pdf', {
      maxPages: 5,
      workDir: out,
      ocr: () => Promise.reject(new Error('Tesseract was called')),
    });
    expect(got).toMatchObject({ source: 'pdf', ocrPages: 0 });
    expect(got?.text).toMatch(/renewal due 01\/02\/2027/);
  }, 600_000);
});
