import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HELD_OUT, TUNED, type SmartEntry } from '@fdv/shared/testdata';
import { describe, expect, it } from 'vitest';

/**
 * The Smart exit's corpus (0.8.0, S5; scripts/smart-corpus.mjs): two
 * hundred made-up papers, the same bytes for the same seed — so a
 * measurement can be run again on exactly what was measured — in the mix
 * the exit asks for.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface Corpus {
  seed: number;
  household: { name: string; people: Array<{ key: string; name: string; role: string | null }> };
  files: Array<{
    path: string;
    bytes: Buffer;
    entry: SmartEntry & { sha256: string; pages: number };
  }>;
}
const load = async () =>
  (await import(
    /* @vite-ignore */ pathToFileURL(path.join(ROOT, 'scripts/smart-corpus.mjs')).href
  )) as { smartCorpus: (o: { seed: number }) => Corpus };

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('the Smart exit’s corpus (S5)', () => {
  let first: Corpus;

  it('is the same bytes for the same seed', async () => {
    const { smartCorpus } = await load();
    first = smartCorpus({ seed: 1 });
    const again = smartCorpus({ seed: 1 });
    expect(again.files.map((f) => f.path)).toEqual(first.files.map((f) => f.path));
    expect(again.files.map((f) => sha(f.bytes))).toEqual(first.files.map((f) => sha(f.bytes)));
    expect(again.files.map((f) => f.entry)).toEqual(first.files.map((f) => f.entry));
    // The manifest says each file's own bytes.
    for (const f of first.files) expect(f.entry.sha256).toBe(sha(f.bytes));
  }, 180_000);

  it('is the mix the exit asks for', () => {
    const files = first.files.map((f) => f.entry);
    expect(files).toHaveLength(200);
    const scans = files.filter((f) => f.mode === 'scan').length;
    // About four in ten only a picture of the page.
    expect(scans).toBeGreaterThanOrEqual(70);
    expect(scans).toBeLessThanOrEqual(90);
    expect(files.filter((f) => f.pages > 1).length).toBeGreaterThanOrEqual(3);
    expect(files.filter((f) => f.blank)).toHaveLength(3);
    // Two the same bytes as another, and one scanned again.
    expect(files.filter((f) => f.duplicate_of !== null)).toHaveLength(2);
    expect(new Set(files.map((f) => f.sha256)).size).toBe(198);
    expect(files.filter((f) => f.rescan_of !== null)).toHaveLength(1);
    // About one in ten of no kind the vault keeps.
    const noKind = files.filter((f) => f.truth.kind === null && !f.blank).length;
    expect(noKind).toBeGreaterThanOrEqual(15);
    expect(noKind).toBeLessThanOrEqual(25);
    // Kept as a family keeps them: tidy, flat and misfiled.
    expect(files.filter((f) => f.folder === 'Scans').length).toBeGreaterThan(20);
    expect(files.filter((f) => f.folder?.includes('/')).length).toBeGreaterThan(60);
    expect(files.filter((f) => f.misfiled).length).toBeGreaterThanOrEqual(5);
    // Every paper a PDF the vault takes (a batch item is 5 MB at most in the tests).
    for (const f of first.files) {
      expect(f.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(f.bytes.length).toBeLessThan(5 * 1024 * 1024);
    }
    // The family the papers name, as the vault will know them.
    expect(first.household.people.map((p) => [p.name, p.role])).toEqual([
      ['Olivia', 'owner'],
      ['Ahmed', 'adult'],
      ['Tariq', 'teen'],
      ['Maryam', null],
      ['Granny Farida', null],
    ]);
  });

  it('holds out a set of layouts, and copies nothing of 5.37’s fixtures', () => {
    const files = first.files.map((f) => f.entry);
    const held = files.filter((f) => f.set === 'held-out');
    expect(held.length).toBeGreaterThanOrEqual(60);
    // A layout is in one set: what the rules were adjusted on is never held out.
    const tuned = new Set(files.filter((f) => f.set === 'tune').map((f) => f.paper));
    expect(held.filter((f) => tuned.has(f.paper))).toEqual([]);
    // None of the numbers of the papers the rules were written with (5.37).
    const theirs = [...TUNED, ...HELD_OUT]
      .map((f) => f.truth.identifier?.replace(/\s/g, ''))
      .filter((n): n is string => !!n);
    const ours = files.map((f) => f.truth.number?.replace(/\s/g, '')).filter(Boolean);
    expect(ours.filter((n) => theirs.includes(n as string))).toEqual([]);
  });
});
