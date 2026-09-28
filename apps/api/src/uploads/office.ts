import { PassThrough, type Readable } from 'node:stream';
import yauzl from 'yauzl';

/**
 * What a Word or Excel file sent through a request really is (5.21, A40).
 *
 * Both are zips, and a zip says what it is in a part of its own,
 * `[Content_Types].xml`. A file is taken only when that part is there and
 * names the main part of a Word document or an Excel workbook — never one
 * with macros (`vbaProject.bin`, or a macro-enabled main part), whatever it
 * is called. Anything else in a zip (a PowerPoint, a folder of photos, a zip
 * of zips) is not taken either.
 *
 * The zip is read where it is kept, encrypted: `read` gives the plain bytes
 * of a range, decrypted chunk by chunk, so no plain copy of a stranger's
 * file is ever written anywhere. Only the zip's directory and its content
 * types are read, each bounded: nothing is unpacked.
 *
 * yauzl (MIT) is the reader; 5.37 reuses it for the words of a Word file.
 */

export const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** How a range of the file's plain bytes is read: [start, end), end excluded. */
export type ReadRange = (start: number, end: number) => Promise<Buffer>;

/** Why an Office file is not taken. */
export type OfficeRefusal = 'macros' | 'not_office';

export type OfficeVerdict = { mime: string } | { refused: OfficeRefusal };

/** A zip with more parts than this is not a document anybody typed. */
const MAX_ENTRIES = 10_000;
/** `[Content_Types].xml` is a few kilobytes; one larger than this is not an Office file's. */
const MAX_CONTENT_TYPES = 256 * 1024;

/** yauzl's reader, over a range reader. */
class RangeReader extends yauzl.RandomAccessReader {
  constructor(private readonly readRange: ReadRange) {
    super();
  }

  override _readStreamForRange(start: number, end: number): Readable {
    const out = new PassThrough();
    if (end <= start) {
      out.end();
      return out;
    }
    this.readRange(start, end).then(
      (b) => out.end(b),
      (e: unknown) => out.destroy(e as Error),
    );
    return out;
  }
}

/**
 * Word, Excel, or refused — from the zip itself. Throws only when the zip
 * cannot be read at all (then it is not an Office file either: the caller
 * refuses it as `not_office`).
 */
export async function inspectOffice(size: number, readRange: ReadRange): Promise<OfficeVerdict> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromRandomAccessReader(
      new RangeReader(readRange),
      size,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: false },
      (err, z) => (err || !z ? reject(err ?? new Error('not a zip')) : resolve(z)),
    );
  });
  try {
    if (zip.entryCount > MAX_ENTRIES) return { refused: 'not_office' };
    let types: yauzl.Entry | null = null;
    let macros = false;
    await new Promise<void>((resolve, reject) => {
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        if (/(^|\/)vbaProject\.bin$/i.test(name) || /(^|\/)vbaData\.xml$/i.test(name)) {
          macros = true;
        }
        if (name === '[Content_Types].xml') types = entry;
        zip.readEntry();
      });
      zip.on('end', () => resolve());
      zip.on('error', reject);
      zip.readEntry();
    });
    if (macros) return { refused: 'macros' };
    const found = types as yauzl.Entry | null;
    if (!found || found.uncompressedSize > MAX_CONTENT_TYPES) return { refused: 'not_office' };
    const xml = await readEntry(zip, found);
    // A macro-enabled main part (.docm, .xlsm, a template with macros) says
    // so here even when its macros are elsewhere.
    if (/macroEnabled|vbaProject/i.test(xml)) return { refused: 'macros' };
    if (/wordprocessingml\.document\.main\+xml/i.test(xml)) return { mime: WORD_MIME };
    if (/spreadsheetml\.sheet\.main\+xml/i.test(xml)) return { mime: EXCEL_MIME };
    return { refused: 'not_office' };
  } finally {
    zip.close();
  }
}

/** One small part of the zip, read to its end within its declared size. */
function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error('unreadable part'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_CONTENT_TYPES) {
          stream.destroy(new Error('part too large'));
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
  });
}
