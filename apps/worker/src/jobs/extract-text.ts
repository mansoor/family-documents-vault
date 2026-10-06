import {
  detectTools,
  ocrImage,
  pdfImageCoverage,
  pdfPageCount,
  pdfPageTexts,
  renderPdfPage,
  renderPdfPages,
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
 *   scan's own text layer — never reaches Tesseract (N537E-02).
 * - A photo or a scan is OCR'd.
 * - A Word file gives the words in its XML.
 * - Anything else (an Excel workbook) gives none.
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
  /** Reads one drawn page or photo: Tesseract, in English, unless a test stands in for it. */
  ocr?: (image: string) => Promise<string>;
}

export interface ExtractedText {
  /** The words, pages in order and a blank line between them; '' for a file with none. */
  text: string;
  /** How it was read. */
  source: 'pdf' | 'ocr' | 'word';
  /** Pages read by their own text, and pages drawn and OCR'd. */
  textPages: number;
  ocrPages: number;
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
  const ocr = opts.ocr ?? ((image: string) => ocrImage(image));
  if (mime === WORD_MIME) {
    return { text: kept(await wordText(file)), source: 'word', textPages: 0, ocrPages: 0 };
  }
  if (IMAGES.has(mime)) {
    if (!tools.tesseract) return null;
    return { text: kept(await ocr(file)), source: 'ocr', textPages: 0, ocrPages: 1 };
  }
  if (mime === 'application/pdf') return readPdf(file, opts, tools, ocr);
  return null;
}

async function readPdf(
  file: string,
  opts: ExtractOptions,
  tools: Tools,
  ocr: (image: string) => Promise<string>,
): Promise<ExtractedText | null> {
  const canOcr = tools.tesseract && tools.pdftoppm;
  const total = tools.pdftoppm ? await pdfPageCount(file) : null;
  // The text the PDF carries; none when it cannot be read that way (an
  // older image without pdftotext, a file pdftotext refuses), and then
  // every page is OCR'd, as before 5.37.
  let own: string[] = [];
  if (tools.pdftotext) {
    own = await pdfPageTexts(file, Math.min(total ?? opts.maxPages, opts.maxPages)).catch(() => []);
  }
  const pages = total !== null ? Math.min(total, opts.maxPages) : own.length;
  // How much of each page is a picture: none of a text page's, all of a scan's.
  const coverage = tools.pdfimages && pages > 0 ? await pdfImageCoverage(file, pages) : null;
  if (pages === 0) {
    // Nothing could count its pages: draw what there is, and OCR it.
    if (!canOcr) return null;
    const drawn = await renderPdfPages(file, opts.workDir, opts.maxPages);
    const texts: string[] = [];
    for (const page of drawn) texts.push(await ocr(page));
    return { text: kept(texts.join('\n\n')), source: 'ocr', textPages: 0, ocrPages: drawn.length };
  }
  const texts: string[] = [];
  let textPages = 0;
  let ocrPages = 0;
  for (let n = 1; n <= pages; n += 1) {
    const words = own[n - 1] ?? '';
    const count = letters(words);
    if (count > 0) textPages += 1;
    const pictured = coverage ? (coverage.get(n) ?? 0) >= MIN_PICTURE_COVER : null;
    const scan = count < MIN_PAGE_TEXT || (count < SHORT_PAGE_TEXT && (pictured ?? true));
    if (!scan || !canOcr) {
      texts.push(words.trim());
      continue;
    }
    // A scan, drawn and read; with any text of its own kept beside it.
    const read = (await ocr(await renderPdfPage(file, opts.workDir, n))).trim();
    texts.push(count > 0 ? `${words.trim()}\n${read}` : read);
    ocrPages += 1;
  }
  if (textPages === 0 && ocrPages === 0 && !tools.pdftotext) return null;
  return {
    text: kept(texts.filter((t) => t !== '').join('\n\n')),
    source: ocrPages > 0 ? 'ocr' : 'pdf',
    textPages,
    ocrPages,
  };
}
