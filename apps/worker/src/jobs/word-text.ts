import yauzl from 'yauzl';

/**
 * The words of a Word file (5.37), for search and for proposing its
 * details. A .docx is a zip; its words are in `word/document.xml`, and a
 * letter's letterhead is often in a header part, so those are read first
 * and the footers last. Read with yauzl (MIT), the zip reader 5.21 added
 * for checking what a request's Office files are.
 *
 * Only text is taken: the runs of `<w:t>`, a tab or a break where Word
 * puts one, a line for each paragraph and a tab between table cells.
 * Nothing in the file is run or followed — a field's code, a link's target,
 * a deleted run's words, an embedded object are all left alone — and no
 * entity is expanded but XML's own five and character references.
 *
 * Everything is bounded: the parts in the zip, the bytes read of them, and
 * the time taken. A file that is not a Word file, or that goes past those,
 * is refused with an error and gives no text.
 */

export const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A Word file has tens of parts; a few hundred is generous. */
const MAX_ENTRIES = 500;
/** The most of its XML read, uncompressed, all parts together. */
export const MAX_WORD_XML = 16 * 1024 * 1024;
/** Headers and footers read, at most, of each. */
const MAX_SIDE_PARTS = 6;
/** How long reading one file may take. */
const TIME_BUDGET_MS = 30_000;

const MAIN = 'word/document.xml';
const HEADER = /^word\/header\d*\.xml$/;
const FOOTER = /^word\/footer\d*\.xml$/;

export class NotWordError extends Error {
  constructor(why: string) {
    super(`not a readable Word file: ${why}`);
    this.name = 'NotWordError';
  }
}

/** The words of the Word file at `file`: its headers, its body, then its footers. */
export async function wordText(file: string): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NotWordError('took too long')), TIME_BUDGET_MS);
  });
  try {
    return await Promise.race([read(file), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function read(file: string): Promise<string> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(
      file,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: false },
      (err, z) => (err || !z ? reject(new NotWordError('not a zip')) : resolve(z)),
    );
  });
  try {
    if (zip.entryCount > MAX_ENTRIES) throw new NotWordError('too many parts');
    const entries: yauzl.Entry[] = [];
    await new Promise<void>((resolve, reject) => {
      zip.on('entry', (entry: yauzl.Entry) => {
        entries.push(entry);
        zip.readEntry();
      });
      zip.on('end', () => resolve());
      zip.on('error', () => reject(new NotWordError('a broken zip')));
      zip.readEntry();
    });
    const named = (re: RegExp) =>
      entries
        .filter((e) => re.test(e.fileName))
        .sort((a, b) => a.fileName.localeCompare(b.fileName, 'en', { numeric: true }))
        .slice(0, MAX_SIDE_PARTS);
    const main = entries.find((e) => e.fileName === MAIN);
    if (!main) throw new NotWordError(`no ${MAIN}`);
    let budget = MAX_WORD_XML;
    const words: string[] = [];
    for (const entry of [...named(HEADER), main, ...named(FOOTER)]) {
      if (entry.uncompressedSize > budget) throw new NotWordError('too large');
      budget -= entry.uncompressedSize;
      const text = wordXmlText(await readEntry(zip, entry, entry.uncompressedSize));
      if (text.trim() !== '') words.push(text.trim());
    }
    return words.join('\n\n');
  } finally {
    zip.close();
  }
}

/** One part, read to its end within its declared size. */
function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, most: number): Promise<string> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(new NotWordError('an unreadable part'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (c: Buffer) => {
        size += c.length;
        if (size > most) {
          stream.destroy(new NotWordError('a part larger than it says'));
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', () => reject(new NotWordError('an unreadable part')));
    });
  });
}

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** XML's five entities and character references; anything else is dropped, never expanded. */
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (_, ref: string) => {
    if (ref.startsWith('#')) {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '';
    }
    return NAMED[ref] ?? '';
  });
}

/**
 * The text of one part of a Word file's XML: the runs of `<w:t>` (any
 * prefix), a tab for `<w:tab/>`, a new line for `<w:br/>` and `<w:cr/>`
 * and after each paragraph — and a table's row on one line, its cells
 * apart by tabs, so a label stays beside its value. Deleted runs
 * (`<w:delText>`) and field codes (`<w:instrText>`) are not text anyone
 * reads, and are left out.
 */
export function wordXmlText(xml: string): string {
  const out: string[] = [];
  let line = '';
  let inText = false;
  let cells = 0;
  const end = () => {
    out.push(line.replace(/[\t ]+$/, ''));
    line = '';
  };
  const tags = /<(\/?)(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)(?:\s[^>]*?)?(\/?)>|([^<]+)|</g;
  for (const m of xml.matchAll(tags)) {
    if (m[4] !== undefined) {
      if (inText) line += decode(m[4]);
      continue;
    }
    const name = m[2];
    if (name === undefined) continue;
    const closing = m[1] === '/';
    const empty = m[3] === '/';
    switch (name) {
      case 't':
        inText = !closing && !empty;
        break;
      case 'tab':
        if (!closing) line += '\t';
        break;
      case 'br':
      case 'cr':
        if (!closing) line += '\n';
        break;
      case 'tc':
        if (closing) {
          cells = Math.max(0, cells - 1);
          line = `${line.replace(/[\t ]+$/, '')}\t`;
        } else if (!empty) {
          cells += 1;
        }
        break;
      case 'tr':
        if (closing) end();
        break;
      case 'p':
        // A paragraph in a table's cell goes on with the row.
        if (closing || empty) {
          if (cells > 0) line += ' ';
          else end();
        }
        break;
    }
  }
  if (line.trim() !== '') out.push(line);
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
