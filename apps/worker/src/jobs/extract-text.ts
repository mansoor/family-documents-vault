import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseTsvPage, readScanPage, type ScanTools } from './scan-read.js';
import {
  cleanForOcr,
  detectTools,
  imagePage,
  imagePageCount,
  ocrImage,
  osdOf,
  ocrTsv,
  pdfPageCount,
  pdfImageCoverage,
  pdfPageTexts,
  prepareScan,
  renderPdfPage,
  renderPdfPages,
  skewOf,
  smallTurned,
  type Tools,
} from './tools.js';
import { WORD_MIME, wordText } from './word-text.js';

/**
 * A file's words (5.37): what search indexes and what `proposeDetails`
 * reads. A function of a file and the kind of file it is, and nothing else
 * — no document, no version, no database — so it reads a filed document's
 * version (`version.process`) and, later, a file that is not a document yet
 * (Phase 6's inbox) the same way.
 *
 * - A PDF gives the text it carries (pdftotext, laid out as the page is),
 *   page by page. A page that is a scan is drawn and OCR'd too: one with
 *   no text of its own, or one with only a line or so (under 200 letters)
 *   that a picture covers a tenth of or more (the review: a scan with a
 *   printed header line had its scan dropped). Such a page keeps both
 *   texts, so nothing searched before 5.37 is lost. A page with more text
 *   of its own — a text PDF's, an illustrated brochure's, a searchable
 *   scan's own text layer — never reaches Tesseract (N537E-02). A drawn page
 *   Tesseract reads next to no words of is cleaned of its speckle and read
 *   again (0.8.0, S5).
 * - A photo or a scan is OCR'd: each of its pages (a TIFF's frames, up to
 *   `maxPages`) drawn grey and upright by ImageMagick, under its limits,
 *   first (0.9.0, R3) — turned by its EXIF orientation, which Tesseract
 *   ignores, and a picture bigger than the limits refused before
 *   Tesseract sees it.
 * - A Word file gives the words in its XML.
 * - Anything else (an Excel workbook) gives none.
 *
 * Since 0.9.0 (R3) a drawn page or photo is read as scan-read.ts reads it:
 * Tesseract's words with their places, laid out in the page's rows as a
 * PDF's own text is, so a label keeps the value beside it; and a page read
 * badly is turned the way up it reads, straightened, evened out, made
 * bigger or cleaned, and read again — kept where it reads clearly more.
 *
 * OCR is Tesseract's English (A46), on the worker's own machine: no page
 * ever leaves it. What is read is returned, never logged: the caller keeps
 * it as the document's visibility says (plain, or sealed for Only me: 5.9).
 */

export interface ExtractOptions {
  /** The most pages of a PDF read (FDV_OCR_MAX_PAGES): by their own text, or OCR'd. */
  maxPages: number;
  /** A folder of the caller's for the pages drawn for OCR; the caller removes it. */
  workDir: string;
  /** The tools there are; found out when not given. */
  tools?: Tools;
  /**
   * Reads one drawn page or photo: scan-read.ts's `readScanPage` with
   * Tesseract, in English, unless a test stands in for it.
   */
  ocr?: (image: string, how?: ReadHow) => Promise<string>;
  /** Reads a drawn page row by row (Tesseract's --psm 6), unless a test stands in for it. */
  ocrRows?: (image: string) => Promise<string>;
  /** Cleans a drawn page for a second reading: `cleanForOcr`, unless a test stands in for it. */
  clean?: (image: string, output: string, signal?: AbortSignal) => Promise<void>;
  /**
   * Ends the reading when aborted (Phase 6, I2: an item's read has a
   * deadline): every tool still running is killed. Pages read before it
   * are kept (`unreadPages` says how many were not, the R3 re-check);
   * none read, it throws.
   */
  signal?: AbortSignal;
  /**
   * When second looks end (the R3 re-check: half a version's deadline):
   * every page after it is read once — no second look, no cleaning (S5),
   * no reading again row by row — and a second look under way ends there,
   * its best reading kept, so the pages left are read before the deadline.
   */
  looksUntil?: AbortSignal;
}

/** How a page is to be read: `once`, with no second look; told when it has read a cleaned copy. */
export interface ReadHow {
  once?: boolean;
  onCleaned?: () => void;
}

export interface ExtractedText {
  /** The words, pages in order and a blank line between them; '' for a file with none. */
  text: string;
  /** How it was read. */
  source: 'pdf' | 'ocr' | 'word';
  /** Pages read by their own text, and pages drawn and OCR'd. */
  textPages: number;
  ocrPages: number;
  /**
   * Scanned pages not read because `signal` ended the reading part-way
   * (the R3 re-check): there only then, and the text is the pages read
   * before it — and a PDF's own text of the rest.
   */
  unreadPages?: number;
}

/** A page whose own text has fewer letters and digits than this is a scan: it is OCR'd. */
export const MIN_PAGE_TEXT = 16;
/**
 * A page with little text of its own (under `SHORT_PAGE_TEXT`) that a
 * picture covers this much of is a scan with a line of text — a print
 * header, "Scanned with CamScanner" — and is OCR'd too (C537-07).
 */
export const MIN_PICTURE_COVER = 0.1;
/**
 * A page with this much text of its own is read by it, pictures or not: a
 * brochure's photos, or a searchable scan's own text layer, are never
 * OCR'd again (N537E-02). Under it, a page with a picture over a tenth of
 * it — or whose pictures cannot be measured — is OCR'd as well.
 */
export const SHORT_PAGE_TEXT = 200;
/**
 * The most text kept of one file. Search's index of a version has room for
 * about this much (a tsvector is at most 1 MB); a document's details are on
 * its first pages.
 */
export const MAX_TEXT_CHARS = 500_000;

const IMAGES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/heic',
  'image/heif',
]);

const letters = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;

/**
 * Fewer words than this from a scanned page's OCR, and it is cleaned
 * (`cleanForOcr`) and read again (0.8.0, S5). A page Tesseract reads at all
 * gives dozens; a blank page none, either way; a short line of a page, a
 * few.
 */
export const OCR_AGAIN_WORDS = 3;

/**
 * Whether OCR read a form column by column (S5): four or more short lines
 * of labels in a row — a few words, no digits — and after them three or more
 * short lines of values, each with a digit: "Statement date / Card number
 * ending / Previous balance / Payment due", then "18 August 2026 / 4929 /
 * £429.79". Its labels no longer stand beside their values.
 */
export function columnsApart(text: string): boolean {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const words = (l: string) => l.split(/\s+/).length;
  const label = (l: string) =>
    !/\d/.test(l) && words(l) <= 4 && !/[.,;:]$/.test(l) && /^[A-Za-z]/.test(l);
  const value = (l: string) => /\d/.test(l) && words(l) <= 4;
  let labelsEnd = -1;
  for (let i = 0, run = 0; i < lines.length; i += 1) {
    run = label(lines[i] as string) ? run + 1 : 0;
    if (run >= 4) labelsEnd = i;
  }
  if (labelsEnd < 0) return false;
  for (let i = labelsEnd + 1, run = 0; i < lines.length; i += 1) {
    run = value(lines[i] as string) ? run + 1 : 0;
    if (run >= 3) return true;
  }
  return false;
}

/** The words OCR read: four letters or more, with a vowel — not the specks it took for letters. */
export const wordsIn = (s: string): number =>
  (s.match(/\b[A-Za-z]{4,}\b/g) ?? []).filter((w) => /[aeiouy]/i.test(w)).length;
const kept = (s: string) => s.trim().slice(0, MAX_TEXT_CHARS);

/**
 * The words of `file`, read as the kind of file `mime` says it is; null
 * when the vault cannot read that kind, or has not the tools to. Throws
 * when a tool fails on the file, or it is not what it says.
 */
export async function extractText(
  file: string,
  mime: string,
  opts: ExtractOptions,
): Promise<ExtractedText | null> {
  const tools = opts.tools ?? (await detectTools());
  const signal = opts.signal;
  const ocr =
    opts.ocr ??
    ((image: string, how?: ReadHow) => readScan(image, tools, signal, how, opts.looksUntil));
  signal?.throwIfAborted();
  if (mime === WORD_MIME) {
    return { text: kept(await wordText(file)), source: 'word', textPages: 0, ocrPages: 0 };
  }
  if (IMAGES.has(mime)) {
    if (!tools.tesseract) return null;
    if (!tools.magick) {
      return { text: kept(await ocr(file)), source: 'ocr', textPages: 0, ocrPages: 1 };
    }
    // Each page drawn grey and upright, under ImageMagick's limits, only as
    // it is read, then read as a drawn PDF page is, and let go.
    const pages = await imagePageCount(file, mime, opts.maxPages, signal);
    const texts: string[] = [];
    try {
      for (let i = 0; i < pages; i += 1) {
        signal?.throwIfAborted();
        const page = await imagePage(file, mime, opts.workDir, i, signal);
        try {
          texts.push(await ocrPage(page, opts, tools, ocr));
        } finally {
          await dropPage(page);
        }
      }
    } catch (err) {
      // Its deadline passed part-way: the pages read before it are kept.
      if (!signal?.aborted || texts.length === 0) throw err;
    }
    return {
      text: kept(texts.filter((t) => t !== '').join('\n\n')),
      source: 'ocr',
      textPages: 0,
      ocrPages: texts.length,
      ...(texts.length < pages ? { unreadPages: pages - texts.length } : {}),
    };
  }
  if (mime === 'application/pdf') return readPdf(file, opts, tools, ocr);
  return null;
}

async function readPdf(
  file: string,
  opts: ExtractOptions,
  tools: Tools,
  ocr: (image: string, how?: ReadHow) => Promise<string>,
): Promise<ExtractedText | null> {
  const canOcr = tools.tesseract && tools.pdftoppm;
  const signal = opts.signal;
  const total = tools.pdftoppm ? await pdfPageCount(file, signal) : null;
  // The text the PDF carries; none when it cannot be read that way (an
  // older image without pdftotext, a file pdftotext refuses), and then
  // every page is OCR'd, as before 5.37.
  let own: string[] = [];
  if (tools.pdftotext) {
    own = await pdfPageTexts(file, Math.min(total ?? opts.maxPages, opts.maxPages), signal).catch(
      () => [],
    );
  }
  const pages = total !== null ? Math.min(total, opts.maxPages) : own.length;
  // How much of each page is a picture: none of a text page's, all of a scan's.
  const coverage =
    tools.pdfimages && pages > 0 ? await pdfImageCoverage(file, pages, signal) : null;
  if (pages === 0) {
    // Nothing could count its pages: draw what there is, and OCR it.
    if (!canOcr) return null;
    const drawn = await renderPdfPages(file, opts.workDir, opts.maxPages, 150, signal);
    const texts: string[] = [];
    for (const page of drawn) {
      texts.push(await ocrPage(page, opts, tools, ocr));
      await dropPage(page);
    }
    return { text: kept(texts.join('\n\n')), source: 'ocr', textPages: 0, ocrPages: drawn.length };
  }
  const texts: string[] = [];
  let textPages = 0;
  let ocrPages = 0;
  // Scanned pages its deadline stopped it before reading (the R3 re-check).
  let unread = 0;
  for (let n = 1; n <= pages; n += 1) {
    const words = own[n - 1] ?? '';
    const count = letters(words);
    if (count > 0) textPages += 1;
    const pictured = coverage ? (coverage.get(n) ?? 0) >= MIN_PICTURE_COVER : null;
    const scan = count < MIN_PAGE_TEXT || (count < SHORT_PAGE_TEXT && (pictured ?? true));
    if (!scan || !canOcr || unread > 0) {
      // Past its deadline, a scan keeps only the text it carries.
      if (scan && canOcr) unread += 1;
      texts.push(words.trim());
      continue;
    }
    // A scan, drawn and read; with any text of its own kept beside it.
    try {
      signal?.throwIfAborted();
      const drawn = await renderPdfPage(file, opts.workDir, n, 150, signal);
      try {
        const read = await ocrPage(drawn, opts, tools, ocr);
        texts.push(count > 0 ? `${words.trim()}\n${read}` : read);
      } finally {
        await dropPage(drawn);
      }
      ocrPages += 1;
    } catch (err) {
      // Its deadline passed: the pages read before it are kept.
      if (!signal?.aborted) throw err;
      unread += 1;
      texts.push(words.trim());
    }
  }
  const text = kept(texts.filter((t) => t !== '').join('\n\n'));
  // Told to stop before anything was read (a tool killed, its error
  // swallowed above): not read.
  if (unread > 0 && text === '') signal?.throwIfAborted();
  if (textPages === 0 && ocrPages === 0 && !tools.pdftotext) return null;
  return {
    text,
    source: ocrPages > 0 ? 'ocr' : 'pdf',
    textPages,
    ocrPages,
    ...(unread > 0 ? { unreadPages: unread } : {}),
  };
}

/**
 * A page read, let go (0.9.0, R3, the review): the page drawn, and every
 * copy made of it to read it again (`page-3-turn90.png`, `page-3-ready.png`,
 * `page-3-clean.png`), so a long scan's pages do not pile up in the folder
 * until its job ends.
 */
async function dropPage(page: string): Promise<void> {
  const dir = path.dirname(page);
  const base = path.basename(page).replace(/\.png$/i, '');
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (name === `${base}.png` || name.startsWith(`${base}-`)) {
      await rm(path.join(dir, name), { force: true }).catch(() => undefined);
    }
  }
}

/**
 * A page read by scan-read.ts with the real tools: Tesseract's words, its
 * orientation model where the worker has it, and ImageMagick to turn and
 * prepare — each step stopped by the signal it is given (the read's, or the
 * second look's budget). `how.once`: no second look; none either after
 * `until` (ExtractOptions.looksUntil).
 */
function readScan(
  image: string,
  tools: Tools,
  signal?: AbortSignal,
  how?: ReadHow,
  until?: AbortSignal,
): Promise<string> {
  const real: ScanTools = {
    words: async (i, s) => parseTsvPage(await ocrTsv(i, 'eng', s ?? signal)),
    skew: (i, s) => skewOf(i, s ?? signal),
    small: (i, turn, out, s) => smallTurned(i, turn, out, s ?? signal),
    prepare: (i, how, out, s) => prepareScan(i, how, out, s ?? signal),
    ...(tools.osd ? { orient: (i: string, s?: AbortSignal) => osdOf(i, s ?? signal) } : {}),
  };
  return readScanPage(image, tools.magick ? real : { words: real.words }, signal, {
    ...(how?.once ? { once: true } : {}),
    ...(until ? { until } : {}),
    ...(how?.onCleaned ? { onCleaned: how.onCleaned } : {}),
  });
}

/**
 * A drawn page read; and where that gives next to no words — a grainy,
 * low-resolution scan Tesseract cannot see the letters of — cleaned and
 * read again, the reading with more words kept (0.8.0, S5). Once second
 * looks have ended (`looksUntil`), read once and that is all.
 */
async function ocrPage(
  image: string,
  opts: ExtractOptions,
  tools: Tools,
  ocr: (image: string, how?: ReadHow) => Promise<string>,
): Promise<string> {
  const signal = opts.signal;
  if (opts.looksUntil?.aborted) return (await ocr(image, { once: true })).trim();
  const read = await ocrGrainy(image, opts, tools, ocr);
  if (opts.looksUntil?.aborted || !columnsApart(read)) return read;
  // A form read column by column — its labels, then its values far below
  // them: read again row by row, kept where that is no longer so (S5).
  signal?.throwIfAborted();
  const rows = (
    await (opts.ocrRows ?? ((i: string) => ocrImage(i, 'eng', signal, '6')))(image)
  ).trim();
  return !columnsApart(rows) && wordsIn(rows) >= wordsIn(read) * 0.8 ? rows : read;
}

async function ocrGrainy(
  image: string,
  opts: ExtractOptions,
  tools: Tools,
  ocr: (image: string, how?: ReadHow) => Promise<string>,
): Promise<string> {
  const signal = opts.signal;
  // A page its second look has read cleaned already is not cleaned again
  // (the R3 re-check): S5's cleaning is the same, and doubled its size again.
  const looked = { cleaned: false };
  const first = (
    await ocr(image, {
      onCleaned: () => {
        looked.cleaned = true;
      },
    })
  ).trim();
  if (!tools.magick || looked.cleaned || opts.looksUntil?.aborted) return first;
  if (wordsIn(first) >= OCR_AGAIN_WORDS) return first;
  signal?.throwIfAborted();
  const cleaned = `${image.replace(/\.png$/, '')}-clean.png`;
  try {
    await (opts.clean ?? cleanForOcr)(image, cleaned, signal);
  } catch {
    signal?.throwIfAborted();
    return first;
  }
  // Itself a second look: read once.
  const second = (await ocr(cleaned, { once: true })).trim();
  return wordsIn(second) > wordsIn(first) ? second : first;
}
