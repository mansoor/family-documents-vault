import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ZipArchive } from 'archiver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proposeDetails } from '@fdv/shared';
import { extractText, MAX_TEXT_CHARS } from './extract-text.js';
import { detectTools, ocrImage } from './tools.js';
import { NotWordError, WORD_MIME, wordText, wordXmlText } from './word-text.js';

const run = promisify(execFile);

/**
 * 5.37: a file's words, read as cheaply as they can be. A PDF that carries
 * its text is read for it and never drawn for Tesseract; only a page with
 * none is; a Word file gives the words in its XML. The PDF tests need
 * poppler (pdftotext, pdftoppm) and Tesseract, and the scanned page
 * ImageMagick and a font — the worker image's tools: they run in the
 * worker's Alpine image, and skip on a machine without them.
 */

const tools = await detectTools();
const pdfText = Boolean(tools.pdftotext && tools.pdftoppm);
const scans = pdfText && tools.tesseract && tools.magick;

/** A PDF of the objects given, in order, built by hand: a binary stream is kept as bytes. */
function pdf(objects: Array<string | Buffer[]>): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let size = parts[0]?.length ?? 0;
  const offsets: number[] = [];
  const push = (b: Buffer) => {
    parts.push(b);
    size += b.length;
  };
  objects.forEach((o, i) => {
    offsets.push(size);
    push(Buffer.from(`${i + 1} 0 obj\n`, 'latin1'));
    for (const b of typeof o === 'string' ? [Buffer.from(o, 'latin1')] : o) push(b);
    push(Buffer.from('\nendobj\n', 'latin1'));
  });
  const xref = size;
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) tail += `${String(off).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(parts);
}

const textStream = (line: string) => {
  const s = `BT /F1 20 Tf 40 700 Td (${line}) Tj ET`;
  return `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
};

/** One page of text, in a plain font: a PDF that carries its words. */
function textPdf(line: string): Buffer {
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    textStream(line),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

/** A page of text, then a page that is only a picture of words: a scan, as a scanner files it. */
function mixedPdf(line: string, scan: { jpeg: Buffer; width: number; height: number }): Buffer {
  const draw = 'q 612 0 0 792 0 0 cm /Im1 Do Q';
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    textStream(line),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R /Resources << /XObject << /Im1 8 0 R >> >> >>',
    `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
    [
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${scan.width} /Height ${scan.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${scan.jpeg.length} >>\nstream\n`,
        'latin1',
      ),
      scan.jpeg,
      Buffer.from('\nendstream', 'latin1'),
    ],
  ]);
}

/**
 * A page that is a picture with a line of real text in its text layer: a
 * scan with a header line. The line is not drawn (rendering mode 3, as an
 * OCR layer is), so only the page's own text can give it back.
 */
function scanWithHeader(header: string, scan: { jpeg: Buffer; width: number; height: number }) {
  const draw = `q 612 0 0 792 0 0 cm /Im1 Do Q BT 3 Tr /F1 9 Tf 20 780 Td (${header}) Tj ET`;
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> >>',
    `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    [
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${scan.width} /Height ${scan.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${scan.jpeg.length} >>\nstream\n`,
        'latin1',
      ),
      scan.jpeg,
      Buffer.from('\nendstream', 'latin1'),
    ],
  ]);
}

/**
 * A schedule laid out as a table: each label in one column, its value in
 * another, as an insurer's PDF sets them (the review's key/value table).
 */
function tablePdf(rows: Array<[string, string]>): Buffer {
  const lines = rows
    .map(([k, v], i) => {
      const y = 700 - i * 24;
      return `BT /F1 11 Tf 72 ${y} Td (${k}) Tj ET BT /F1 11 Tf 320 ${y} Td (${v}) Tj ET`;
    })
    .join(' ');
  const head = 'BT /F1 16 Tf 72 740 Td (Home Insurance Policy Schedule) Tj ET';
  const content = `${head} ${lines}`;
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

/** A page of words drawn as a JPEG, as a scanner draws one. */
async function scanImage(dir: string, words: string[]): Promise<Buffer> {
  const picture = path.join(dir, `scan-${words.length}-${words[0]?.length ?? 0}.jpg`);
  const font = await run('fc-match', ['-f', '%{file}', 'sans-serif'])
    .then(({ stdout }) => stdout.trim())
    .catch(() => '');
  await run(tools.magick ? 'magick' : 'convert', [
    '-size',
    '1275x1650',
    'xc:white',
    ...(font ? ['-font', font] : []),
    '-pointsize',
    '64',
    '-fill',
    'black',
    ...words.flatMap((w, i) => ['-annotate', `+100+${400 + i * 120}`, w]),
    '-quality',
    '90',
    `jpeg:${picture}`,
  ]);
  return readFile(picture);
}

/** A Word file of the parts given, as Word zips them. */
async function docx(parts: Record<string, string>): Promise<Buffer> {
  const zip = new ZipArchive({ zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  zip.on('data', (c: Buffer) => chunks.push(c));
  const ended = new Promise<void>((resolve, reject) => {
    zip.on('end', () => resolve());
    zip.on('error', reject);
  });
  for (const [name, body] of Object.entries(parts)) zip.append(body, { name });
  await zip.finalize();
  await ended;
  return Buffer.concat(chunks);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (...runs: string[]) =>
  `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${runs
    .map((r) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${r}</w:t></w:r>`)
    .join('')}</w:p>`;
const row = (...cells: string[]) =>
  `<w:tr>${cells.map((c) => `<w:tc>${para(c)}</w:tc>`).join('')}</w:tr>`;

const WORD_PARTS = {
  '[Content_Types].xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels':
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/header1.xml': `<?xml version="1.0"?><w:hdr ${W}>${para('Northgate Lettings Ltd')}</w:hdr>`,
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${para(
    'ASSURED SHORTHOLD ',
    'TENANCY AGREEMENT',
  )}${para('Rent &amp; deposit: &#163;1,150 &lt;monthly&gt;')}<w:p><w:r><w:t>Term</w:t></w:r><w:r><w:tab/><w:t>12 months</w:t></w:r><w:r><w:br/><w:t>from 1 September 2026</w:t></w:r></w:p><w:p><w:r><w:delText>Struck out by the landlord</w:delText></w:r><w:r><w:instrText> HYPERLINK "https://x.example" </w:instrText></w:r></w:p><w:tbl>${row(
    'Tenant',
    'Sara Khan',
  )}${row('Deposit scheme', 'DPS 4471')}</w:tbl></w:body></w:document>`,
  'word/footer1.xml': `<?xml version="1.0"?><w:ftr ${W}>${para('Registered in England No. 1234567')}</w:ftr>`,
};

describe('extracting text (5.37)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-extract-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** An OCR that keeps a note of every page it is asked to read. */
  const counting = (read: (image: string) => Promise<string> = ocrImage) => {
    const asked: string[] = [];
    return {
      asked,
      ocr: async (image: string) => {
        asked.push(image);
        return read(image);
      },
    };
  };

  it.skipIf(!pdfText)('a text PDF is read, and Tesseract is never called', async () => {
    const file = path.join(dir, 'policy.pdf');
    await writeFile(file, textPdf('POLICY NUMBER 4471 EFFECTIVE 12 MARCH 2026'));
    const { asked, ocr } = counting(() => Promise.reject(new Error('Tesseract was called')));
    const got = await extractText(file, 'application/pdf', { maxPages: 5, workDir: dir, ocr });
    expect(asked).toEqual([]);
    expect(got).toMatchObject({ source: 'pdf', textPages: 1, ocrPages: 0 });
    expect(got?.text.replace(/\s+/g, ' ')).toBe('POLICY NUMBER 4471 EFFECTIVE 12 MARCH 2026');
  });

  it.skipIf(!scans)(
    "a scanned page in a mixed PDF is OCR'd, and only that page",
    async () => {
      // A page of words, drawn as a picture: what a scanner puts in a PDF.
      const picture = path.join(dir, 'scan.jpg');
      const font = await run('fc-match', ['-f', '%{file}', 'sans-serif'])
        .then(({ stdout }) => stdout.trim())
        .catch(() => '');
      await run(tools.magick ? 'magick' : 'convert', [
        '-size',
        '1275x1650',
        'xc:white',
        ...(font ? ['-font', font] : []),
        '-pointsize',
        '64',
        '-fill',
        'black',
        '-annotate',
        '+100+400',
        'SCANNED PAGE 7731',
        '-annotate',
        '+100+520',
        'RECEIVED WITH THANKS',
        '-quality',
        '90',
        `jpeg:${picture}`,
      ]);
      const file = path.join(dir, 'mixed.pdf');
      await writeFile(
        file,
        mixedPdf('THE FIRST PAGE CARRIES ITS OWN WORDS', {
          jpeg: await readFile(picture),
          width: 1275,
          height: 1650,
        }),
      );
      const { asked, ocr } = counting();
      const got = await extractText(file, 'application/pdf', { maxPages: 5, workDir: dir, ocr });
      // Page 2 alone was drawn and read.
      expect(asked).toHaveLength(1);
      expect(path.basename(asked[0] as string)).toBe('page-2.png');
      expect(got).toMatchObject({ source: 'ocr', textPages: 1, ocrPages: 1 });
      const text = got?.text.replace(/\s+/g, ' ') ?? '';
      expect(text).toContain('THE FIRST PAGE CARRIES ITS OWN WORDS');
      expect(text).toMatch(/SCANNED PAGE 7731/);
      // In page order.
      expect(text.indexOf('FIRST PAGE')).toBeLessThan(text.indexOf('SCANNED'));
    },
    120_000,
  );

  it.skipIf(!scans)(
    "without pdftotext, every page is OCR'd, as before",
    async () => {
      const file = path.join(dir, 'older.pdf');
      await writeFile(file, textPdf('READ BY TESSERACT INSTEAD 2290'));
      const { asked, ocr } = counting();
      const got = await extractText(file, 'application/pdf', {
        maxPages: 5,
        workDir: dir,
        ocr,
        tools: { ...tools, pdftotext: false },
      });
      expect(asked).toHaveLength(1);
      expect(got?.text.replace(/\s+/g, ' ')).toMatch(/READ BY TESSERACT INSTEAD 2290/);
    },
    120_000,
  );

  it.skipIf(!scans)(
    "a scanned page that also carries a line of text is OCR'd, and keeps both (C537-07)",
    async () => {
      const jpeg = await scanImage(dir, ['ELECTRICITY BILL 4471', 'AMOUNT DUE 187 POUNDS']);
      for (const header of [
        // A browser's print header: a date, a file name, its address, 1/1.
        '05/10/2026, 18:42 file:///C:/Users/me/Downloads/bill-scan.pdf energy bill 1/1',
        'Scanned with CamScanner by a phone in the kitchen',
      ]) {
        const file = path.join(dir, 'header-scan.pdf');
        await writeFile(file, scanWithHeader(header, { jpeg, width: 1275, height: 1650 }));
        const { asked, ocr } = counting();
        const got = await extractText(file, 'application/pdf', { maxPages: 5, workDir: dir, ocr });
        expect(asked, header).toHaveLength(1);
        const text = got?.text.replace(/\s+/g, ' ') ?? '';
        // The scan is read, and the line it carried is kept beside it.
        expect(text, header).toMatch(/ELECTRICITY BILL 4471/);
        expect(text, header).toContain(header);
      }
    },
    120_000,
  );

  it.skipIf(!pdfText)(
    "a table's labels stay beside their values, so a text PDF's dates and number are proposed (C537-08)",
    async () => {
      const file = path.join(dir, 'schedule.pdf');
      await writeFile(
        file,
        tablePdf([
          ['Policy number', 'HQ-4471-2290'],
          ['Policyholder', 'Mrs Sara Khan'],
          ['Start date', '15 June 2025'],
          ['End date', '14 June 2026'],
          ['Annual premium', '412.80'],
        ]),
      );
      const got = await extractText(file, 'application/pdf', { maxPages: 5, workDir: dir });
      expect(got?.source).toBe('pdf');
      const p = proposeDetails(got?.text ?? '', {
        types: [
          {
            key: 'insurance_policy',
            label: 'Insurance policy',
            fields: [],
            expiry_driver: 'expires_on',
            issued_by_label: 'Insurer',
          },
        ],
        people: [{ id: 'm-sara', name: 'Sara' }],
        household: 'The Khan family',
        dateOrder: 'dmy',
        current: { type_key: 'insurance_policy' },
      });
      expect(p.issued?.value.date).toBe('2025-06-15');
      expect(p.expires?.value.date).toBe('2026-06-14');
      expect(p.identifier?.value).toBe('HQ-4471-2290');
    },
    60_000,
  );

  it('megabytes of unclosed tags are turned into text in linear time (P537-01)', () => {
    // Unclosed to the end: nothing after them closes a tag.
    const xml = `<w:document ${W}><w:body>${para('Start')}${'<a '.repeat(80_000)}`;
    const started = Date.now();
    expect(wordXmlText(xml)).toBe('Start');
    // Quadratic, this took seconds (and megabytes, hours); linear, milliseconds.
    expect(Date.now() - started).toBeLessThan(1_500);
  }, 30_000);

  it('a Word file of megabytes of unclosed tags is read on its own thread: the worker keeps ticking (P537-01)', async () => {
    const file = path.join(dir, 'unclosed.docx');
    await writeFile(
      file,
      await docx({
        ...WORD_PARTS,
        'word/document.xml': `<w:document ${W}><w:body>${para('Start')}${'<a '.repeat(3_000_000)}`,
      }),
    );
    let ticks = 0;
    const tick = setInterval(() => (ticks += 1), 5);
    const started = Date.now();
    try {
      const text = await wordText(file);
      expect(text).toContain('Start');
    } finally {
      clearInterval(tick);
    }
    const took = Date.now() - started;
    expect(took).toBeLessThan(20_000);
    // The event loop ran all the while: a tick every few milliseconds.
    expect(ticks).toBeGreaterThan(Math.floor(took / 5 / 4));
  }, 60_000);

  it('turning XML into text stops at its deadline, whatever it is doing (P537-01)', async () => {
    const file = path.join(dir, 'slow.docx');
    await writeFile(
      file,
      await docx({
        ...WORD_PARTS,
        'word/document.xml': `<w:document ${W}><w:body>${para('Start').repeat(80_000)}</w:body></w:document>`,
      }),
    );
    const started = Date.now();
    await expect(wordText(file, { deadlineMs: 30 })).rejects.toThrow('took too long');
    expect(Date.now() - started).toBeLessThan(5_000);
    // Given the time, the same file is read.
    expect(await wordText(file)).toContain('Start');
  }, 60_000);

  it('a Word file gives its text: its header, its body and its tables, then its footer', async () => {
    const file = path.join(dir, 'tenancy.docx');
    await writeFile(file, await docx(WORD_PARTS));
    const { asked, ocr } = counting(() => Promise.reject(new Error('Tesseract was called')));
    const got = await extractText(file, WORD_MIME, { maxPages: 5, workDir: dir, ocr, tools });
    expect(asked).toEqual([]);
    expect(got?.source).toBe('word');
    expect(got?.text).toBe(
      [
        'Northgate Lettings Ltd',
        '',
        'ASSURED SHORTHOLD TENANCY AGREEMENT',
        'Rent & deposit: £1,150 <monthly>',
        'Term\t12 months',
        'from 1 September 2026',
        '',
        // A table's row on a line, its cells apart.
        'Tenant\tSara Khan',
        'Deposit scheme\tDPS 4471',
        '',
        'Registered in England No. 1234567',
      ].join('\n'),
    );
    // Deleted words and field codes are not the document's.
    expect(got?.text).not.toContain('Struck out');
    expect(got?.text).not.toContain('HYPERLINK');
  });

  it('a Word file that is not one — no body, or no zip — is refused, never half read', async () => {
    const noBody = path.join(dir, 'empty.docx');
    const rest = Object.fromEntries(
      Object.entries(WORD_PARTS).filter(([name]) => name !== 'word/document.xml'),
    );
    await writeFile(noBody, await docx(rest));
    await expect(wordText(noBody)).rejects.toBeInstanceOf(NotWordError);
    const notZip = path.join(dir, 'fake.docx');
    await writeFile(notZip, 'PK\u0003\u0004 not really a zip');
    await expect(
      extractText(notZip, WORD_MIME, { maxPages: 5, workDir: dir, tools }),
    ).rejects.toBeInstanceOf(NotWordError);
  });

  it('XML is read as text: entities are not expanded, and a document type adds nothing', () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE w [<!ENTITY big "BOOM">]><w:document ${W}><w:body>${para(
      'A &big; B &#x41; &#0; &#xD800; C',
    )}</w:body></w:document>`;
    expect(wordXmlText(xml)).toBe('A  B A   C');
  });

  it('a photo is read by OCR; a workbook is not read', async () => {
    const photo = path.join(dir, 'photo.png');
    await writeFile(photo, 'not decoded here');
    const { asked, ocr } = counting(() => Promise.resolve('  PHOTO WORDS  '));
    const got = await extractText(photo, 'image/png', {
      maxPages: 5,
      workDir: dir,
      ocr,
      tools: { pdftoppm: false, magick: false, tesseract: true },
    });
    expect(asked).toEqual([photo]);
    expect(got).toEqual({ text: 'PHOTO WORDS', source: 'ocr', textPages: 0, ocrPages: 1 });
    // No Tesseract, no reading.
    expect(
      await extractText(photo, 'image/png', {
        maxPages: 5,
        workDir: dir,
        ocr,
        tools: { pdftoppm: false, magick: false, tesseract: false },
      }),
    ).toBeNull();
    const sheet = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    expect(await extractText(photo, sheet, { maxPages: 5, workDir: dir, ocr, tools })).toBeNull();
  });

  it('no more than MAX_TEXT_CHARS is kept of one file', async () => {
    const photo = path.join(dir, 'long.png');
    await writeFile(photo, 'x');
    const got = await extractText(photo, 'image/png', {
      maxPages: 5,
      workDir: dir,
      ocr: () => Promise.resolve('word '.repeat(200_000)),
      tools: { pdftoppm: false, magick: false, tesseract: true },
    });
    expect(got?.text.length).toBe(MAX_TEXT_CHARS);
  });
});
