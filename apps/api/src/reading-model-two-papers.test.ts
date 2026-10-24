import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ITEM_SURE,
  levelItem,
  proposeOnThread,
  type ProposalContext,
  type ReadingModel,
} from '@fdv/shared';
import { FIXTURE_KINDS } from '@fdv/shared/testdata';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Two papers in one file (the R2 review): the reading model, very sure of
 * the first paper's kind or of the second's, never makes a card Ready that
 * the rules alone would not — the rules' cues name the second paper's kind
 * close behind, and the model reads the whole file as well as its start.
 * Built from pairs the review's probe found Ready and wrong (and the same
 * probe on these papers' own words): a repeat slip and an employment
 * contract (Ready as a contract), a water bill and a DVLA letter (as a
 * driving licence), a repeat slip, a health centre's letter or a GP's and
 * a bank statement (as a bank statement).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const load = async <T>(rel: string) =>
  (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href)) as T;

interface Page {
  items: Array<{ x: number; y: number; text: string; size: number }>;
}
type Corpus = {
  files: Array<{ path: string; pages?: Page[]; entry: { truth: { kind: string | null } } }>;
};

const PEOPLE = ['Olivia', 'Ahmed', 'Tariq', 'Maryam', 'Granny Farida'].map((name, i) => ({
  id: `m-${i}`,
  name,
}));
const CTX: ProposalContext = { types: FIXTURE_KINDS, people: PEOPLE, dateOrder: 'dmy' };

describe('two papers in one file, with the reading model (R2)', () => {
  let model: ReadingModel;
  const texts = new Map<string, { text: string; kind: string | null }>();

  beforeAll(async () => {
    const loaded = (
      await load<{ loadReadingModel(): { model: ReadingModel | null } }>(
        'apps/worker/src/reading-model.ts',
      )
    ).loadReadingModel().model;
    if (!loaded) throw new Error('the reading model is not here');
    model = loaded;
    const smart = await load<{
      smartCorpus(o: { seed: number; corpus: string; withPages: boolean }): Corpus;
    }>('scripts/smart-corpus.mjs');
    const { drawnText } = await load<{ drawnText: (p: Page[]) => string }>(
      'scripts/train-reading-model.mjs',
    );
    for (const [corpus, seed] of [
      ['second', 2],
      ['third', 3],
    ] as const) {
      for (const f of smart.smartCorpus({ seed, corpus, withPages: true }).files) {
        if (f.pages) {
          texts.set(`${corpus}:${f.path}`, {
            text: drawnText(f.pages),
            kind: f.entry.truth.kind,
          });
        }
      }
    }
  }, 300_000);

  const card = (text: string, withModel: boolean) =>
    levelItem({
      state: 'waiting',
      reading: 'read',
      failure: null,
      proposal: proposeOnThread(text, CTX, null, withModel ? model : null).proposal,
      duplicate: null,
      defaults: {
        type_key: null,
        owner_member_id: null,
        visibility: 'household',
        physical_location: null,
        collection_id: null,
        tags: [],
        is_essential: false,
      },
      types: FIXTURE_KINDS.map((k) => ({ ...k, default_visibility: 'household' as const })),
      people: PEOPLE,
      role: 'owner',
      me: 'm-0',
    });

  it.each([
    ['second:Scans/scan015.pdf', 'second:Olivia/Job/contract.pdf'],
    [
      'third:Household bills/2026/riverbend-water 2026-10.pdf',
      'second:Ahmed/Driving licence/DVLA letter.pdf',
    ],
    ['second:Scans/scan004.pdf', 'third:Thornbury/Olivia/statement 2026-07.pdf'],
    [
      'second:Health/Maryam/health-centre-letter 2026-03.pdf',
      'third:Thornbury/Ahmed/statement 2026-01.pdf',
    ],
    ['second:Scans/scan013.pdf', 'third:Downloads/statement 2025-11.pdf'],
    ['second:Scans/scan017.pdf', 'third:Scans/scan020.pdf'],
    ['second:Bills 2026/phone-invoice 2026-08.pdf', 'second:Insurance/Car/Corvus 2026-06.pdf'],
    [
      'third:Household bills/2025/brackenford-council-tax 2025-03.pdf',
      'second:Olivia/Tax/p60-single-column 2025.pdf',
    ],
  ])('%s then %s: never Ready by the model, never as the second paper', (a, b) => {
    const first = texts.get(a);
    const second = texts.get(b);
    if (!first || !second) throw new Error(`not in the corpus: ${a} or ${b}`);
    const both = `${first.text}\n\n${second.text}`;
    // The kind the rules alone held unsure is never made sure by the model.
    const rules = proposeOnThread(both, CTX, null, null).proposal.type_key;
    const read = proposeOnThread(both, CTX, null, model).proposal.type_key;
    if (!rules || rules.confidence < ITEM_SURE.type_key) {
      expect(read?.confidence ?? 0).toBeLessThan(ITEM_SURE.type_key);
      expect(read?.model).not.toBe('agrees');
    }
    const without = card(both, false);
    const withModel = card(both, true);
    // The model makes nothing Ready the rules alone would not.
    if (without.level !== 'ready') expect(withModel.level).not.toBe('ready');
    if (withModel.level === 'ready') {
      expect(withModel.proposals?.type_key?.value).not.toBe(second.kind);
    }
  });
});
