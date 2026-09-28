import { PassThrough, type Readable } from 'node:stream';
import yauzl from 'yauzl';

/**
 * What a Word or Excel file sent through a request really is (5.21, A40).
 *
 * Both are zips (Open Packaging), and a package says what it is in parts
 * of its own: `_rels/.rels` names its main part, and `[Content_Types].xml`
 * says what each part is. A file is taken only as the Word document or
 * Excel workbook its main part is declared to be, exactly — and never with
 * anything that runs or reaches outside: a VBA project (by its content
 * type, its relationship or its name, wherever it is and whatever it is
 * called), a macro-enabled or template main part (.docm, .xlsm, .dotm,
 * .xltm), a macro sheet, an ActiveX control, an embedded OLE object, or a
 * template, frame or OLE object fetched from elsewhere. Anything else in a
 * zip (a PowerPoint, a jar, a folder of photos) is not taken either.
 *
 * The XML is read as XML: comments and processing instructions are set
 * aside, character references and the five named ones decoded, and a
 * document type, an entity of its own or CDATA refused — a check that
 * matched text would be defeated by `macro&#69;nabled` or a comment.
 *
 * The zip is read where it is kept, encrypted: `read` gives one chunk of
 * the plain file, decrypted, and each is decrypted once and kept while the
 * zip is walked (the directory, then a few small parts), so reading it
 * costs about as much as the file's own size and no more. Everything is
 * bounded: the parts in the directory, the size of each part read, what is
 * read in all, the chunks decrypted, and the time taken. yauzl (MIT) reads
 * the zip; 5.37 reuses it for the words of a Word file.
 */

export const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const WORD_MAIN =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const EXCEL_MAIN = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const OFFICE_DOCUMENT =
  'http://schemas.openxmlformats.org/officedocument/2006/relationships/officedocument';

/** Why an Office file is not taken. */
export type OfficeRefusal = 'macros' | 'not_office';

export type OfficeVerdict = { mime: string } | { refused: OfficeRefusal };

/** The plain file, one chunk at a time: chunk `i` covers [i × chunkSize, (i + 1) × chunkSize). */
export interface PlainChunks {
  size: number;
  chunkSize: number;
  read(index: number): Promise<Buffer>;
}

/** Real documents and workbooks have tens of parts; a few hundred is generous. */
export const MAX_ENTRIES = 500;
/** A package part that is read ([Content_Types].xml, a .rels) is a few kilobytes. */
const MAX_PART = 256 * 1024;
/** And no more than this is read of parts in all. */
const MAX_READ = 4 * 1024 * 1024;
/** Relationship parts read, at most. */
const MAX_RELS = 200;
/** How long the whole check may take. */
const TIME_BUDGET_MS = 10_000;
/** Chunks kept decrypted while the zip is walked. */
const KEPT_CHUNKS = 4;

/** A content type that carries code or reaches outside: refused wherever it is declared. */
const RUNS = /vbaproject|vbadata|macroenabled|macrosheet|activex|oleobject|ms-office\.vba|addin/i;
/** A relationship that brings code in. */
const RUNS_REL =
  /vbaproject|vbadata|activex|oleobject|macrosheet|attachedtoolbars|keymapcustomizations/i;
/** A relationship that fetches something from elsewhere when it is outside the package. */
const FETCHES_REL = /attachedtemplate|oleobject|frame|subdocument|package/i;
/** A part named like code, wherever it is and whatever the package calls it. */
const CODE_NAMES = /(^|\/)(vbaproject|vbaprojectsignature|vbadata)\.[a-z0-9]+$|(^|\/)activex\//i;

class OverBudget extends Error {}

/**
 * The plain file as yauzl asks for it, a range at a time, from chunks each
 * decrypted once while it is wanted. Counts the chunks decrypted, and stops
 * past `maxChunks`.
 */
export class ChunkCache {
  private readonly kept = new Map<number, Promise<Buffer>>();
  decrypted = 0;

  constructor(
    private readonly plain: PlainChunks,
    private readonly maxChunks: number,
  ) {}

  private chunk(i: number): Promise<Buffer> {
    const had = this.kept.get(i);
    if (had) {
      // Most recently used last.
      this.kept.delete(i);
      this.kept.set(i, had);
      return had;
    }
    if (++this.decrypted > this.maxChunks) {
      return Promise.reject(new OverBudget('too many chunks read'));
    }
    const got = this.plain.read(i);
    this.kept.set(i, got);
    while (this.kept.size > KEPT_CHUNKS) {
      const oldest = this.kept.keys().next().value as number;
      this.kept.delete(oldest);
    }
    return got;
  }

  /** The plain bytes of [start, end). */
  async range(start: number, end: number): Promise<Buffer> {
    const cs = this.plain.chunkSize;
    const parts: Buffer[] = [];
    for (let i = Math.floor(start / cs); i * cs < end; i++) {
      const c = await this.chunk(i);
      const from = Math.max(start - i * cs, 0);
      const to = Math.min(end - i * cs, c.length);
      parts.push(c.subarray(from, to));
    }
    return Buffer.concat(parts);
  }
}

/** yauzl's reader, over the chunk cache. */
class RangeReader extends yauzl.RandomAccessReader {
  constructor(private readonly cache: ChunkCache) {
    super();
  }

  override _readStreamForRange(start: number, end: number): Readable {
    const out = new PassThrough();
    if (end <= start) {
      out.end();
      return out;
    }
    this.cache.range(start, end).then(
      (b) => out.end(b),
      (e: unknown) => out.destroy(e as Error),
    );
    return out;
  }
}

/**
 * Word, Excel, or refused — from the package itself. A zip that cannot be
 * read, or that takes too long or too much to read, is not an Office file.
 * `cache`, when given, is the one the zip is read through, for a caller
 * that counts what was decrypted.
 */
export async function inspectOffice(
  plain: PlainChunks,
  cache = new ChunkCache(plain, 2 * Math.ceil(plain.size / plain.chunkSize) + 8),
): Promise<OfficeVerdict> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<OfficeVerdict>((resolve) => {
    timer = setTimeout(() => resolve({ refused: 'not_office' }), TIME_BUDGET_MS);
  });
  try {
    return await Promise.race([walk(plain.size, cache), late]);
  } catch {
    return { refused: 'not_office' };
  } finally {
    clearTimeout(timer);
  }
}

async function walk(size: number, cache: ChunkCache): Promise<OfficeVerdict> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromRandomAccessReader(
      new RangeReader(cache),
      size,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: false },
      (err, z) => (err || !z ? reject(err ?? new Error('not a zip')) : resolve(z)),
    );
  });
  try {
    if (zip.entryCount > MAX_ENTRIES) return { refused: 'not_office' };
    const entries: yauzl.Entry[] = [];
    await new Promise<void>((resolve, reject) => {
      zip.on('entry', (entry: yauzl.Entry) => {
        entries.push(entry);
        zip.readEntry();
      });
      zip.on('end', () => resolve());
      zip.on('error', reject);
      zip.readEntry();
    });
    if (entries.some((e) => CODE_NAMES.test(e.fileName))) return { refused: 'macros' };
    const byName = new Map(entries.map((e) => [e.fileName.toLowerCase(), e]));
    let read = 0;
    const part = async (entry: yauzl.Entry | undefined): Promise<string | null> => {
      if (!entry || entry.uncompressedSize > MAX_PART || entry.compressedSize > MAX_PART) {
        return null;
      }
      read += entry.uncompressedSize;
      if (read > MAX_READ) throw new OverBudget('too much read');
      return readEntry(zip, entry);
    };

    // What each part is.
    const typesXml = await part(byName.get('[content_types].xml'));
    const types = typesXml === null ? null : parseXml(typesXml);
    if (!types) return { refused: 'not_office' };
    const defaults = new Map<string, string>();
    const overrides = new Map<string, string>();
    for (const el of types) {
      const type = el.attrs.contenttype?.trim().toLowerCase();
      if (!type) continue;
      if (RUNS.test(type)) return { refused: 'macros' };
      if (el.name === 'default' && el.attrs.extension) {
        defaults.set(el.attrs.extension.trim().toLowerCase().replace(/^\./, ''), type);
      }
      if (el.name === 'override' && el.attrs.partname) {
        overrides.set(partName(el.attrs.partname), type);
      }
    }
    const typeOf = (name: string) =>
      overrides.get(partName(name)) ?? defaults.get(name.split('.').pop()?.toLowerCase() ?? '');

    // What the package's parts point at: nothing that runs, nothing fetched.
    const rels = entries.filter((e) => /\.rels$/i.test(e.fileName));
    if (rels.length > MAX_RELS) return { refused: 'not_office' };
    let main: string | null = null;
    for (const r of rels) {
      const xml = await part(r);
      const els = xml === null ? null : parseXml(xml);
      if (!els) return { refused: 'not_office' };
      for (const el of els) {
        if (el.name !== 'relationship') continue;
        const type = (el.attrs.type ?? '').trim().toLowerCase();
        const external = (el.attrs.targetmode ?? '').trim().toLowerCase() === 'external';
        if (RUNS_REL.test(type) || (external && FETCHES_REL.test(type))) {
          return { refused: 'macros' };
        }
        if (r.fileName === '_rels/.rels' && type === OFFICE_DOCUMENT) {
          if (main !== null || external) return { refused: 'not_office' };
          main = (el.attrs.target ?? '').trim();
        }
      }
    }
    if (!main) return { refused: 'not_office' };
    const mainName = main.replace(/^\/+/, '');
    if (!byName.has(mainName.toLowerCase())) return { refused: 'not_office' };
    const mainType = typeOf(mainName);
    if (mainType === WORD_MAIN) return { mime: WORD_MIME };
    if (mainType === EXCEL_MAIN) return { mime: EXCEL_MIME };
    return { refused: 'not_office' };
  } finally {
    zip.close();
  }
}

/** A part's name as [Content_Types].xml's PartName says it: from the root, in lower case. */
function partName(name: string): string {
  return `/${name.trim().replace(/^\/+/, '')}`.toLowerCase();
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
        if (size > MAX_PART) {
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

/** An element of a package part: its local name and its attributes, in lower case, decoded. */
interface XmlElement {
  name: string;
  attrs: Record<string, string>;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** An attribute's value with its references decoded, or null for one XML does not define here. */
function decode(value: string): string | null {
  let bad = false;
  const out = value.replace(/&([^;&\s]*);?/g, (whole, ref: string) => {
    if (!whole.endsWith(';')) {
      bad = true;
      return '';
    }
    const hex = /^#x([0-9a-f]{1,6})$/i.exec(ref);
    const dec = /^#([0-9]{1,7})$/.exec(ref);
    const code = hex ? parseInt(hex[1] as string, 16) : dec ? Number(dec[1]) : null;
    if (code !== null) {
      if (code > 0x10ffff) {
        bad = true;
        return '';
      }
      return String.fromCodePoint(code);
    }
    const named = NAMED[ref];
    if (named === undefined) bad = true;
    return named ?? '';
  });
  return bad ? null : out;
}

/**
 * The elements of a small XML part, as an XML parser would see them: its
 * comments and processing instructions set aside, character references
 * decoded. A document type, an entity or CDATA of its own, a comment left
 * open, or a reference XML does not define: null, and the file is refused.
 */
export function parseXml(xml: string): XmlElement[] | null {
  // Leading white space, a byte-order mark among it (\s matches U+FEFF).
  let text = xml.replace(/^\s+/, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  if (text.includes('<!')) return null; // DOCTYPE, ENTITY, CDATA, a comment left open
  text = text.replace(/<\?[\s\S]*?\?>/g, '');
  if (text.includes('<?')) return null;
  const out: XmlElement[] = [];
  const tag = /<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*\/?>/g;
  const attr = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g;
  for (const m of text.matchAll(tag)) {
    const name = (m[1] as string).split(':').pop()?.toLowerCase() ?? '';
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? '').matchAll(attr)) {
      const key = (a[1] as string).split(':').pop()?.toLowerCase() ?? '';
      const value = decode(a[2] ?? a[3] ?? '');
      if (value === null) return null;
      attrs[key] = value;
    }
    out.push({ name, attrs });
  }
  return out;
}
