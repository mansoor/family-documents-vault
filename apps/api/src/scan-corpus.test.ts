import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The scan set (0.9.0, R3; scripts/scan-corpus.mjs): the Smart exit's
 * made-up papers drawn again as the scans a family files, a cause each —
 * the same bytes for the same options, the tune split from the first set's
 * papers only and the held-out split from the second and third sets', and
 * no words but the papers' own and a page's "Continued overleaf". A few
 * causes are drawn (`only`), each file as it is in the whole set.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface ScanFile {
  path: string;
  bytes: Buffer;
  entry: {
    cause: string;
    mime: string;
    sha256: string;
    pages: number;
    from: string;
    page_words: string[];
  };
}
const load = async () =>
  (await import(
    /* @vite-ignore */ pathToFileURL(path.join(ROOT, 'scripts/scan-corpus.mjs')).href
  )) as {
    CAUSES: string[];
    scanSet: (o: { split: string; per: number; only?: string[] }) => { files: ScanFile[] };
  };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const MAGIC: Record<string, string> = {
  'application/pdf': '%PDF',
  'image/png': '\x89PNG',
  'image/jpeg': '\xff\xd8\xff\xe0',
};

describe('the scan set (R3)', () => {
  it('is the same bytes for the same options, each cause from its own split’s papers', async () => {
    const { scanSet, CAUSES } = await load();
    const only = ['rotated', 'page2'];
    const tune = scanSet({ split: 'tune', per: 2, only });
    const again = scanSet({ split: 'tune', per: 2, only });
    expect(again.files.map((f) => sha(f.bytes))).toEqual(tune.files.map((f) => sha(f.bytes)));
    expect(again.files.map((f) => f.path)).toEqual(tune.files.map((f) => f.path));
    // Each where it is in the whole set: numbered among all the causes.
    expect(tune.files.map((f) => f.path.split('/')[0])).toEqual([
      'rotated',
      'page2',
      'rotated',
      'page2',
    ]);
    expect(tune.files.map((f) => Number(f.path.split('/')[1]?.slice(0, 3)))).toEqual([
      2,
      CAUSES.length,
      CAUSES.length + 2,
      2 * CAUSES.length,
    ]);
    for (const f of tune.files) {
      expect(f.entry.sha256).toBe(sha(f.bytes));
      // The tune split's papers are the first set's, which the rules were adjusted on.
      expect(f.entry.from.startsWith('first:')).toBe(true);
      // Small enough to add to a batch (5 MB in the tests), and what it says it is.
      expect(f.bytes.length).toBeLessThan(5 * 1024 * 1024);
      expect(f.bytes.subarray(0, 4).toString('latin1')).toBe(MAGIC[f.entry.mime]);
    }
    const page2 = tune.files.filter((f) => f.entry.cause === 'page2');
    for (const f of page2) {
      expect(f.entry.pages).toBe(2);
      expect(f.entry.page_words).toEqual(expect.arrayContaining(['continued', 'overleaf']));
    }
    const heldOut = scanSet({ split: 'held-out', per: 1, only: ['columns'] });
    expect(heldOut.files).toHaveLength(1);
    // Held out: drawn from papers the rules have never been adjusted on.
    expect(heldOut.files[0]?.entry.from).toMatch(/^(second|third):/);
  }, 300_000);
});
