import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SHAPE_WORDS } from '@fdv/shared';
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
  )) as { smartCorpus: (o: { seed: number; corpus?: 'first' | 'second' | 'third' }) => Corpus };

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

  it('a second set, held out: its own seed, layouts and issuers, the same bytes each time', async () => {
    const { smartCorpus } = await load();
    const second = smartCorpus({ seed: 2, corpus: 'second' });
    const again = smartCorpus({ seed: 2, corpus: 'second' });
    expect(again.files.map((f) => sha(f.bytes))).toEqual(second.files.map((f) => sha(f.bytes)));
    const files = second.files.map((f) => f.entry);
    expect(files.length).toBeGreaterThanOrEqual(100);
    expect(files.every((f) => f.set === 'held-out')).toBe(true);
    const scans = files.filter((f) => f.mode === 'scan').length / files.length;
    expect(scans).toBeGreaterThan(0.3);
    expect(scans).toBeLessThan(0.5);
    // Not one layout of the first set.
    const firstPapers = new Set(first.files.map((f) => f.entry.paper));
    expect(files.filter((f) => f.paper !== 'blank' && firstPapers.has(f.paper))).toEqual([]);
    // Nor one of its issuers, but the offices a paper is from wherever it is kept.
    const offices = new Set(['United Kingdom', 'DVLA', 'HMRC']);
    const firstIssuers = new Set(first.files.map((f) => f.entry.truth.issuer));
    expect(
      files
        .map((f) => f.truth.issuer)
        .filter((i): i is string => !!i && !offices.has(i) && firstIssuers.has(i)),
    ).toEqual([]);
    // The kinds 0072 adds are among its papers.
    expect(files.some((f) => f.truth.kind === 'credit_card_statement')).toBe(true);
    expect(files.some((f) => f.truth.kind === 'school_report')).toBe(true);
  }, 180_000);

  it('each set’s files, byte for byte, as recorded in docs/smart-exit.md (the R1 re-check)', async () => {
    const { smartCorpus } = await load();
    const bytesOf = (c: Corpus) =>
      createHash('sha256')
        .update(JSON.stringify(c.files.map((f) => [f.entry.path, sha(f.bytes)])))
        .digest('hex');
    expect({
      first: bytesOf(smartCorpus({ seed: 1 })),
      second: bytesOf(smartCorpus({ seed: 2, corpus: 'second' })),
      third: bytesOf(smartCorpus({ seed: 3, corpus: 'third' })),
    }).toEqual({
      first: 'cdbb31af58cc382df42fb17cf594508ff90ee669f43c33eebf7e5f66c354a11f',
      second: 'dba5d56a3e9dce97e0ff4e68a9703a4472c464e0a62df6373484b4e0e068394a',
      third: '2263d0a95f2780071d968046e70c935a38a3dec0d6760075ac397bebf7893068',
    });
  }, 300_000);

  it('SHAPE_WORDS is as it was frozen again for 0.9.0, after the R1 re-check, in a commit of its own (docs/smart-exit.md)', () => {
    const words = [...SHAPE_WORDS].sort();
    expect(words).toHaveLength(1001);
    expect(createHash('sha256').update(words.join('\n')).digest('hex')).toBe(
      '4fafd5b1787d59299d5ee5ce241e236c12d1a0c9333e2b51e7b14bfbdca64066',
    );
  });

  it('a third set, held out (0.9.0, the R1 review): its own layouts and issuers, a bank three of the family share, and as it was frozen', async () => {
    const { smartCorpus } = await load();
    const third = smartCorpus({ seed: 3, corpus: 'third' });
    const second = smartCorpus({ seed: 2, corpus: 'second' });
    const files = third.files.map((f) => f.entry);
    expect(files.every((f) => f.set === 'held-out')).toBe(true);
    // Frozen before the vault read it: its paths and truths as recorded in docs/smart-exit.md.
    expect(
      createHash('sha256')
        .update(JSON.stringify(third.files.map((f) => [f.entry.path, f.entry.truth])))
        .digest('hex'),
    ).toBe('60feec74d62935e2fc4e329b681561295aaf9faabecf4855ed568ea78998e344');
    // Not one layout, nor one issuer, of either set before it.
    const before = [...first.files, ...second.files].map((f) => f.entry);
    const papers = new Set(before.map((f) => f.paper));
    expect(files.filter((f) => f.paper !== 'blank' && papers.has(f.paper))).toEqual([]);
    const issuers = new Set(before.map((f) => f.truth.issuer));
    expect(files.filter((f) => f.truth.issuer && issuers.has(f.truth.issuer))).toEqual([]);
    // One bank, three of the family: each their own account.
    const bank = files.filter((f) => f.truth.issuer === 'Thornbury Bank');
    expect(new Set(bank.map((f) => f.truth.person))).toEqual(
      new Set(['olivia', 'ahmed', 'maryam']),
    );
    expect(new Set(bank.map((f) => f.truth.number)).size).toBe(3);
  }, 180_000);
});
