import { execFile } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The three command-line tools the worker image ships: poppler
 * (pdftoppm, pdfinfo), ImageMagick (magick) and Tesseract. Wrapped so the
 * rest of the worker never builds a shell command, and so tests can skip
 * cleanly on a machine without them.
 */

export interface Tools {
  pdftoppm: boolean;
  magick: boolean;
  tesseract: boolean;
}

let cached: Tools | null = null;

async function has(bin: string, args: string[]): Promise<boolean> {
  try {
    await run(bin, args, { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function detectTools(): Promise<Tools> {
  if (cached) return cached;
  cached = {
    pdftoppm: await has('pdftoppm', ['-v']),
    magick: (await has('magick', ['-version'])) || (await has('convert', ['-version'])),
    tesseract: await has('tesseract', ['--version']),
  };
  return cached;
}

const MAGICK = async () => ((await has('magick', ['-version'])) ? 'magick' : 'convert');

/** Page count of a PDF, from pdfinfo. */
export async function pdfPageCount(file: string): Promise<number | null> {
  try {
    const { stdout } = await run('pdfinfo', [file], { timeout: 30_000 });
    const m = /^Pages:\s+(\d+)/m.exec(stdout);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Renders the first `maxPages` pages of a PDF to PNGs in `outDir`; returns them in order. */
export async function renderPdfPages(
  file: string,
  outDir: string,
  maxPages: number,
  dpi = 150,
): Promise<string[]> {
  await run(
    'pdftoppm',
    ['-png', '-r', String(dpi), '-f', '1', '-l', String(maxPages), file, path.join(outDir, 'page')],
    {
      timeout: 120_000,
    },
  );
  const files = (await readdir(outDir)).filter((f) => /^page-\d+\.png$/.test(f)).sort();
  return files.map((f) => path.join(outDir, f));
}

/**
 * A JPEG thumbnail, longest side `size`. PDFs go through poppler for the
 * first page (ImageMagick would need Ghostscript for that); images go
 * straight to ImageMagick, which also fixes camera orientation.
 */
export async function thumbnail(input: string, output: string, size = 480): Promise<void> {
  const bin = await MAGICK();
  let src = input;
  if (input.toLowerCase().endsWith('.pdf')) {
    const base = path.join(path.dirname(output), 'thumb-src');
    await run('pdftoppm', ['-png', '-r', '72', '-f', '1', '-l', '1', '-singlefile', input, base], {
      timeout: 60_000,
    });
    src = `${base}.png`;
  }
  await run(
    bin,
    [src, '-auto-orient', '-thumbnail', `${size}x${size}>`, '-quality', '82', '-strip', output],
    { timeout: 60_000 },
  );
  await access(output);
}

/** OCR of one page image. Returns the text, possibly empty. */
export async function ocrImage(file: string, lang = 'eng'): Promise<string> {
  const { stdout } = await run('tesseract', [file, '-', '-l', lang, '--psm', '3'], {
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.replace(/\f/g, '\n').trim();
}

export async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}
