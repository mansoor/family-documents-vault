import { describe, expect, it } from 'vitest';
import { levelItem, type BatchLevel, type LevelKind } from './batch-levels.js';
import { suggestFromFolder } from './folders.js';
import {
  FIXTURE_KINDS,
  FIXTURE_PEOPLE,
  HELD_OUT,
  matches,
  proposeFor,
  TUNED,
  type ProposalFixture,
} from './testdata/index.js';

/**
 * Folder names → suggested details (0.8.0, S2), measured for the Smart exit
 * (S5): 5.37's synthetic documents (both sets), read as the worker reads an
 * item, levelled as the vault levels it — with no folder, and as a family
 * might have sorted them: `Ahmed/Passport/…`, `Bills/…`; and the same tree
 * with every fifth paper in the wrong folder. How many are Ready, Check and
 * Not recognised each way — and the rule that matters most: no Ready item
 * is wrong, however the folders are sorted.
 */

const KINDS: LevelKind[] = FIXTURE_KINDS.map((k) => ({
  key: k.key,
  label: k.label,
  default_visibility: 'household',
  expiry_driver: k.expiry_driver,
  fields: [],
}));

/** The folder a family puts each kind in, as they would name it. */
const FOLDER_OF: Record<string, string> = {
  passport: 'Passport',
  drivers_licence: 'Driving licence',
  birth_certificate: 'Birth certificates',
  insurance_policy: 'Insurance',
  bank_statement: 'Bank statements',
  loan: 'Mortgage',
  medical_record: 'Medical',
  prescription: 'Prescriptions',
  property_deed: 'Deeds',
  tax_form: 'Tax forms',
  utility_bill: 'Bills',
  vehicle_registration: 'Car registration',
  warranty: 'Receipts',
};
const firstName = (id: string) =>
  (FIXTURE_PEOPLE.find((p) => p.id === id)?.name ?? '').split(' ').pop() as string;

/** `Ahmed/Passport/…`, `Bills/…` (a household's own), `Letters/…` for what is no kind. */
function tidy(f: ProposalFixture): string {
  const kind = f.truth.type_key ? (FOLDER_OF[f.truth.type_key] ?? 'Other') : 'Letters';
  if (f.truth.type_key === 'utility_bill' || !f.truth.owner) return `Scans/${kind}/2024`;
  return `Scans/${firstName(f.truth.owner)}/${kind}`;
}
/** The same, with every fifth paper put in the folder of another kind. */
function messy(f: ProposalFixture, i: number): string {
  if (i % 5 !== 0) return tidy(f);
  const kinds = Object.values(FOLDER_OF);
  const wrong = kinds[(kinds.indexOf(FOLDER_OF[f.truth.type_key ?? ''] ?? '') + 3) % kinds.length];
  return f.truth.owner ? `${firstName(f.truth.owner)}/${wrong}` : `${wrong}`;
}

type Outcome = Record<BatchLevel | 'unread', number> & { wrongReady: string[] };

function measure(
  fixtures: readonly ProposalFixture[],
  folderOf: ((f: ProposalFixture, i: number) => string) | null,
): Outcome {
  const out: Outcome = {
    ready: 0,
    check: 0,
    unrecognised: 0,
    problem: 0,
    unread: 0,
    wrongReady: [],
  };
  fixtures.forEach((f, i) => {
    const folder = folderOf
      ? suggestFromFolder(folderOf(f, i), { types: KINDS, people: FIXTURE_PEOPLE })
      : null;
    const level = levelItem({
      state: 'waiting',
      reading: 'read',
      failure: null,
      proposal: proposeFor(f),
      duplicate: null,
      folder,
      defaults: {
        owner_member_id: null,
        type_key: null,
        visibility: null,
        physical_location: null,
        collection_id: null,
        tags: [],
        is_essential: false,
      },
      types: KINDS,
      people: FIXTURE_PEOPLE,
      role: 'adult',
      me: 'm-sara',
    });
    out[level.level ?? 'unread'] += 1;
    if (level.level !== 'ready') return;
    // Ready is the vault's word that nothing needs looking at: every detail
    // the card starts from must be the paper's own.
    const p = level.proposals;
    const said: Array<[string, string | null, string | null]> = [
      ['type_key', p?.type_key?.value ?? null, f.truth.type_key],
      ['owner', p?.owner_member_id?.value ?? null, f.truth.owner],
      ['issued', p?.issued?.value.date ?? null, f.truth.issued],
      ['expires', p?.expires?.value.date ?? null, f.truth.expires],
      ['identifier', p?.identifier?.value ?? null, f.truth.identifier],
      ['issued_by', p?.issued_by?.value ?? null, f.truth.issued_by],
    ];
    for (const [field, got, want] of said) {
      if (got === null) continue;
      if (want === null || !matches(field as never, got, want)) {
        out.wrongReady.push(`${f.name}: ${field} ${got} (is ${want ?? 'none'})`);
      }
    }
  });
  return out;
}

describe('folder names, measured on the synthetic documents (S2, for the S5 exit)', () => {
  const all = [...TUNED, ...HELD_OUT];
  const none = measure(all, null);
  const sorted = measure(all, tidy);
  const muddled = measure(all, messy);

  it('reports Ready, Check and Not recognised with and without folder names', () => {
    const row = (name: string, o: Outcome) =>
      `${name.padEnd(28)} ready ${String(o.ready).padStart(3)}  check ${String(o.check).padStart(3)}  not recognised ${String(o.unrecognised).padStart(3)}  wrong Ready ${o.wrongReady.length}`;
    // Said in the test's output (shared has no console of its own to type).
    (globalThis as { console?: { info: (s: string) => void } }).console?.info(
      [
        `${all.length} synthetic documents (5.37's TUNED and HELD_OUT):`,
        row('no folder', none),
        row('Ahmed/Passport/…, Bills/…', sorted),
        row('…, every fifth misfiled', muddled),
      ].join('\n'),
    );
    expect(none.ready + none.check + none.unrecognised + none.problem).toBe(all.length);
    // Sorted folders help: more Ready, fewer Check; what is no kind at all
    // ("Letters") stays Not recognised.
    expect(sorted.ready).toBeGreaterThan(none.ready);
    expect(sorted.check).toBeLessThan(none.check);
    expect(sorted.unrecognised).toBeLessThanOrEqual(none.unrecognised);
    // Misfiled, the pages win and say so: Check, never a wrong Ready.
    expect(muddled.check).toBeGreaterThan(sorted.check);
  });

  it('no Ready item is wrong, with or without folders, sorted well or badly', () => {
    expect(none.wrongReady).toEqual([]);
    expect(sorted.wrongReady).toEqual([]);
    expect(muddled.wrongReady).toEqual([]);
  });
});
