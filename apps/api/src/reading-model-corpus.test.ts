import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseReadingModel } from '@fdv/shared';
import { HELD_OUT, TUNED } from '@fdv/shared/testdata';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The reading model's training papers (0.9.0, R2;
 * scripts/reading-model-corpus.mjs) are disjoint from every held-out set:
 * the Smart exit's second set (seed 2), R1's third (seed 3) — and so the R3
 * scan set's held-out split, which is those papers drawn again — and the
 * 5.37 fixtures' HELD_OUT. No held-out paper is in them, exactly or nearly:
 * none of their texts the same, none sharing more than a little of its
 * runs of five words with any training paper, and no line of six words or
 * more of a held-out paper on any training paper. Nor do they share a
 * distinctive phrase with the held-out papers (the R2 review and its
 * re-check): every run of three or four words found in a held-out paper and
 * a training paper but in no paper of the tune split — the first set and
 * 5.37's TUNED — must be on the allow-list below, each with why it is no
 * one paper's. No held-out issuer's name, nor any distinctive word of one,
 * is in the training papers (but the public offices every such paper names).
 * And they are the very papers the weights were trained on (the corpus's
 * hash, in the file).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const load = async <T>(rel: string) =>
  (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href)) as T;

interface Page {
  items: Array<{ x: number; y: number; text: string; size: number }>;
}
interface Corpus {
  files: Array<{ path: string; pages?: Page[]; entry?: { truth: { issuer: string | null } } }>;
}

/** Lower case, words alone: how two texts are compared. */
const words = (t: string) => t.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const norm = (t: string) => words(t).join(' ');
/** Its runs of five words. */
const shingles = (t: string) => {
  const w = words(t);
  const out = new Set<string>();
  for (let i = 0; i + 5 <= w.length; i += 1) out.add(w.slice(i, i + 5).join(' '));
  return out;
};
/** Its lines of six words or more. */
const longLines = (t: string) =>
  t
    .split('\n')
    .map(norm)
    .filter((l) => l.split(' ').length >= 6);

/** The most of a held-out paper's runs of five words any one training paper has. */
const NEAR = 0.5;

const MONTH =
  /^(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)$/;
/** A line's runs of n words, each word of letters (a number or a month is a gap: a date says nothing). */
const runs = (t: string, n: number) => {
  const out = new Set<string>();
  for (const line of t.toLowerCase().split('\n')) {
    const w = (line.match(/[a-z']+|[0-9]+/g) ?? []).map((x) =>
      /^[0-9]/.test(x) || MONTH.test(x) ? '#' : x,
    );
    for (let i = 0; i + n <= w.length; i += 1) {
      const run = w.slice(i, i + n);
      if (!run.includes('#')) out.add(run.join(' '));
    }
  }
  return out;
};
/**
 * Phrases shared with the held-out papers that are no one paper's, and why:
 * each printed on every document of its kind, or plain English.
 */
const OFFICIAL = 'an office, a state or a form, as every such document names it';
const LABEL = 'a label every such document prints, or a label and its value';
const PLAIN = 'plain English, in any letter or bill';
const ALLOWED = new Map<string, string>([
  ['united states department of', OFFICIAL],
  ['united states department', OFFICIAL],
  ['states department of state', OFFICIAL],
  ['states department of', OFFICIAL],
  ['department of motor vehicles', OFFICIAL],
  ['department of motor', OFFICIAL],
  ['of motor vehicles', OFFICIAL],
  ["of expiry date d'expiration", 'a passport’s bilingual label'],
  ["expiry date d'expiration", 'a passport’s bilingual label'],
  ['no du passeport', 'a passport’s bilingual label'],
  ['this passport is', 'a passport’s own printed text'],
  ['f k l n', 'a UK driving licence’s categories'],
  ['k l n', 'a UK driving licence’s categories'],
  ['photocard driving licence', 'the DVLA’s name for the licence'],
  ['of year certificate tax', 'a P60’s title, “End of Year Certificate”, then a label'],
  ['year certificate tax', 'a P60’s title, “End of Year Certificate”, then a label'],
  ['council tax band c', 'a council tax band, as every bill names it'],
  ['council tax band', 'a council tax band, as every bill names it'],
  ['tax band c', 'a council tax band, as every bill names it'],
  ['valuation band c', 'a council tax band, as every bill names it'],
  ['contract of employment', 'the document’s own name (and a rule’s veto word)'],
  ['cash isa statement', 'the product’s name, on every such statement'],
  ['checking account statement', 'the product’s name, on every such statement'],
  ['certificate of achievement', 'the certificate’s own name'],
  ['deposits are protected', 'the deposit protection scheme’s required words'],
  ['balance carried forward', 'a statement’s label (in the rules’ own cues)'],
  ['balance brought forward', 'a statement’s label (in the rules’ own cues)'],
  ['english working towards', 'a subject and a national-curriculum grade'],
  ['science working towards', 'a subject and a national-curriculum grade'],
  ['form tutor ms', LABEL],
  ['policy holder mr', LABEL],
  ['loan account number', LABEL],
  ['total amount payable', LABEL],
  ['no claims discount', LABEL],
  ['place of work', LABEL],
  ['next check up', LABEL],
  ['no further action', LABEL],
  ['balance to pay', LABEL],
  ['points earned this', LABEL],
  ['thank you for your', PLAIN],
  ['you for your', PLAIN],
  ['if you do not', PLAIN],
  ['if you do', PLAIN],
  ['to avoid a late', PLAIN],
  ['avoid a late payment', PLAIN],
  ['to avoid a', PLAIN],
  ['avoid a late', PLAIN],
  ['a late payment', PLAIN],
  ['subject to the terms', PLAIN],
  ['subject to the', PLAIN],
  ['check the details', PLAIN],
  ['and by the', PLAIN],
  ['would like to', PLAIN],
  ['day of each', PLAIN],
  ['is due for', PLAIN],
  ['will renew automatically', PLAIN],
  ['cover accidental damage', PLAIN],
  ['your tax return', PLAIN],
  ['for the term', PLAIN],
  ['set out in', PLAIN],
]);

/** Words of an issuer's name that say nothing of which issuer it is. */
const PLAIN_ISSUER_WORDS = new Set(
  (
    'bank building society district council health centre water insurance card cover pet ' +
    'retail ltd direct home store dental bright smile personal loans investments vets savings ' +
    'energy fibre music board school hospital academy surgery park motor rescue valley st ' +
    'united kingdom the of and'
  ).split(' '),
);
/** Public offices every paper from them names, as the training papers do too. */
const PUBLIC_OFFICES = new Set(['DVLA', 'HMRC', 'United Kingdom']);

describe('the reading model’s training papers (R2)', () => {
  let training: Array<{ kind: string; text: string }>;
  let heldOut: Array<{ name: string; text: string }>;
  let tune: string[];
  let issuers: string[];

  beforeAll(async () => {
    const corpus = await load<{
      readingModelCorpus(o: { seed: number; per: number }): Array<{ kind: string; text: string }>;
    }>('scripts/reading-model-corpus.mjs');
    const trainer = await load<{ drawnText(pages: Page[]): string }>(
      'scripts/train-reading-model.mjs',
    );
    const smart = await load<{
      smartCorpus(o: { seed: number; corpus: string; withPages: boolean }): Corpus;
    }>('scripts/smart-corpus.mjs');
    issuers = [
      ...new Set(
        (['second', 'third'] as const).flatMap((c) =>
          smart
            .smartCorpus({ seed: c === 'second' ? 2 : 3, corpus: c, withPages: false })
            .files.flatMap((f) => (f.entry?.truth.issuer ? [f.entry.truth.issuer] : [])),
        ),
      ),
    ];
    // As the weights were trained: seed 1, 300 of each kind.
    training = corpus.readingModelCorpus({ seed: 1, per: 300 });
    heldOut = [
      ...(['second', 'third'] as const).flatMap((c) =>
        smart
          .smartCorpus({ seed: c === 'second' ? 2 : 3, corpus: c, withPages: true })
          .files.filter((f) => f.pages)
          .map((f) => ({ name: `${c}:${f.path}`, text: trainer.drawnText(f.pages as Page[]) })),
      ),
      ...HELD_OUT.map((f) => ({ name: `5.37:${f.name}`, text: f.text })),
    ];
    tune = [
      ...smart
        .smartCorpus({ seed: 1, corpus: 'first', withPages: true })
        .files.filter((f) => f.pages)
        .map((f) => trainer.drawnText(f.pages as Page[])),
      ...TUNED.map((f) => f.text),
    ];
  }, 300_000);

  it('share no distinctive phrase with the held-out papers that the tune split does not have', () => {
    const shared: string[] = [];
    for (const n of [4, 3]) {
      const inTraining = new Map<string, number>();
      for (const p of training) {
        for (const r of runs(p.text, n)) inTraining.set(r, (inTraining.get(r) ?? 0) + 1);
      }
      const inTune = new Set(tune.flatMap((t) => [...runs(t, n)]));
      for (const h of heldOut) {
        for (const r of runs(h.text, n)) {
          if (!inTraining.has(r) || inTune.has(r) || ALLOWED.has(r)) continue;
          if (!shared.includes(r)) shared.push(r);
        }
      }
    }
    expect(shared).toEqual([]);
  });

  it('name no held-out issuer, nor any distinctive word of one (the R2 re-check)', () => {
    expect(issuers.length).toBeGreaterThan(20);
    const text = training.map((p) => p.text.toLowerCase()).join('\n');
    const said = new Set(text.match(/[a-z']+/g) ?? []);
    const found: string[] = [];
    for (const issuer of issuers) {
      if (PUBLIC_OFFICES.has(issuer)) continue;
      if (text.includes(issuer.toLowerCase())) found.push(issuer);
      for (const w of issuer.toLowerCase().match(/[a-z']+/g) ?? []) {
        if (!PLAIN_ISSUER_WORDS.has(w) && said.has(w)) found.push(`${issuer}: ${w}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('are the papers the weights were trained on', () => {
    const hash = createHash('sha256');
    for (const p of training) hash.update(`${p.kind}\n${p.text}\n`);
    const model = parseReadingModel(
      new Uint8Array(readFileSync(path.join(ROOT, 'apps/worker/src/reading-model.bin'))),
    );
    expect(model.trained.corpus_sha256).toBe(hash.digest('hex'));
    expect(training).toHaveLength(8100);
  });

  it('hold no held-out paper, exactly or nearly', () => {
    expect(heldOut.length).toBeGreaterThan(190);
    // Exactly.
    const same = new Set(training.map((p) => norm(p.text)));
    expect(heldOut.filter((h) => same.has(norm(h.text))).map((h) => h.name)).toEqual([]);
    // Nearly: each held-out paper's runs of five words, against every training paper's.
    const index = new Map<string, number[]>();
    training.forEach((p, i) => {
      for (const s of shingles(p.text)) {
        const at = index.get(s);
        if (at) at.push(i);
        else index.set(s, [i]);
      }
    });
    let most = 0;
    const near: string[] = [];
    for (const h of heldOut) {
      const mine = shingles(h.text);
      if (mine.size === 0) continue;
      const hits = new Map<number, number>();
      for (const s of mine) for (const i of index.get(s) ?? []) hits.set(i, (hits.get(i) ?? 0) + 1);
      const best = Math.max(0, ...hits.values()) / mine.size;
      most = Math.max(most, best);
      if (best >= NEAR) near.push(`${h.name} (${best.toFixed(2)})`);
    }
    expect(near).toEqual([]);
    console.log(
      `held-out papers: ${heldOut.length}; the most of one's runs of five words in any training paper: ${(most * 100).toFixed(1)}%`,
    );
    // And no line of six words or more of a held-out paper is a training
    // paper's — but a state's own name, which every passport of it prints.
    const OFFICIAL = new Set(['united kingdom of great britain and northern ireland']);
    const lines = new Set(training.flatMap((p) => longLines(p.text)));
    expect(
      heldOut.flatMap((h) => longLines(h.text).filter((l) => lines.has(l) && !OFFICIAL.has(l))),
    ).toEqual([]);
  });
});
