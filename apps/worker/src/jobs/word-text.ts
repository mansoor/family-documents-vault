import { Worker } from 'node:worker_threads';
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
 * the time taken. The zip is read here, a part at a time — inflating is
 * zlib's, off the event loop — and its XML is turned into text in a
 * worker thread that is stopped at its deadline (the 5.37 review): work on
 * the thread's own loop cannot hold up the worker's jobs, and a deadline
 * that only races a promise could never stop it. A file that is not a
 * Word file, or that goes past those bounds, is refused with an error and
 * gives no text.
 */

export const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A Word file has tens of parts; a few hundred is generous. */
const MAX_ENTRIES = 500;
/** The most of its XML read, uncompressed, all parts together. */
export const MAX_WORD_XML = 16 * 1024 * 1024;
/** Headers and footers read, at most, of each. */
const MAX_SIDE_PARTS = 6;
/** How long reading the zip may take. */
const READ_BUDGET_MS = 30_000;
/** How long turning its XML into text may take: the thread is stopped then. */
export const TEXT_DEADLINE_MS = 20_000;
/** The heap the thread may have: its XML, its text, and room to work. */
const THREAD_HEAP_MB = 256;

const MAIN = 'word/document.xml';
const HEADER = /^word\/header\d*\.xml$/;
const FOOTER = /^word\/footer\d*\.xml$/;

export class NotWordError extends Error {
  constructor(why: string) {
    super(`not a readable Word file: ${why}`);
    this.name = 'NotWordError';
  }
}

/**
 * The words of the Word file at `file`: its headers, its body, then its
 * footers. `deadlineMs` bounds the turning of its XML into text.
 */
export async function wordText(file: string, opts: { deadlineMs?: number } = {}): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NotWordError('took too long')), READ_BUDGET_MS);
  });
  let parts: string[];
  try {
    parts = await Promise.race([readParts(file), late]);
  } finally {
    clearTimeout(timer);
  }
  const texts = await textInThread(parts, opts.deadlineMs ?? TEXT_DEADLINE_MS);
  return texts
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .join('\n\n');
}

/**
 * Each part's text, worked out on a thread of its own, which is ended at
 * the deadline whatever it is doing. The thread is given the function's
 * own source (`wordXmlText` stands alone: it reaches for nothing outside
 * itself), so it is the same code as here, bundled or not.
 */
function textInThread(parts: string[], deadlineMs: number): Promise<string[]> {
  const source = [
    "const { parentPort, workerData } = require('node:worker_threads');",
    `const wordXmlText = ${wordXmlText.toString()};`,
    'parentPort.postMessage(workerData.parts.map((xml) => wordXmlText(xml)));',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const thread = new Worker(source, {
      eval: true,
      workerData: { parts },
      resourceLimits: { maxOldGenerationSizeMb: THREAD_HEAP_MB },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void thread.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new NotWordError('took too long'))),
      deadlineMs,
    );
    thread.once('message', (texts: string[]) => finish(() => resolve(texts)));
    thread.once('error', () => finish(() => reject(new NotWordError('unreadable XML'))));
    thread.once('exit', () => finish(() => reject(new NotWordError('unreadable XML'))));
  });
}

async function readParts(file: string): Promise<string[]> {
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
    const parts: string[] = [];
    for (const entry of [...named(HEADER), main, ...named(FOOTER)]) {
      if (entry.uncompressedSize > budget) throw new NotWordError('too large');
      budget -= entry.uncompressedSize;
      parts.push(await readEntry(zip, entry, entry.uncompressedSize));
    }
    return parts;
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

/**
 * The text of one part of a Word file's XML: the runs of `<w:t>` (any
 * prefix), a tab for `<w:tab/>`, a new line for `<w:br/>` and `<w:cr/>`
 * and after each paragraph — and a table's row on one line, its cells
 * apart by tabs, so a label stays beside its value. Deleted runs
 * (`<w:delText>`) and field codes (`<w:instrText>`) are not text anyone
 * reads, and are left out. XML's five entities and character references
 * are decoded; anything else is dropped, never expanded.
 *
 * Linear in the XML's length: a tag's attributes are read only up to the
 * next `<` (the review: reading on to the next `>` made megabytes of
 * unclosed tags take hours). It stands alone — everything it uses is
 * inside it — because it is run on a thread of its own from its source.
 */
export function wordXmlText(xml: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const decode = (text: string) =>
    text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (_, ref: string) => {
      if (ref.startsWith('#')) {
        const code =
          ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : '';
      }
      return named[ref] ?? '';
    });
  // Trailing spaces and tabs off, from the end only: never a scan of the line.
  const trimEnd = (s: string) => {
    let n = s.length;
    while (n > 0 && (s.charCodeAt(n - 1) === 32 || s.charCodeAt(n - 1) === 9)) n -= 1;
    return n === s.length ? s : s.slice(0, n);
  };
  const out: string[] = [];
  let line = '';
  let inText = false;
  let cells = 0;
  const end = () => {
    out.push(trimEnd(line));
    line = '';
  };
  const tags = /<(\/?)(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)(?:\s[^<>]*?)?(\/?)>|([^<]+)|</g;
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
          line = `${trimEnd(line)}\t`;
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
