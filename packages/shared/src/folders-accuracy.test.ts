import { describe, expect, it } from 'vitest';
import { levelItem, type BatchLevel, type LevelKind } from './batch-levels.js';
import { folderMatcher } from './folders.js';
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
 * is wrong, however the folders are sorted. With them, papers whose folder
 * and pages could be wrong together (the review, M2): Visa card statements
 * in "Visa/", a pension statement in "Statements/", TV licences in
 * "Licences/".
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
  warranty: 'Warranties',
};

/** A new line, between a page's lines. */
const LF = '\n';

/**
 * Papers a folder name and their own words could both get wrong: a Visa
 * card's statements (the word "Visa" is a visa's cue), a pension's annual
 * statement, a TV licence. Each in the folder a family would keep it in.
 */
const CORRELATED: Array<ProposalFixture & { folder: string }> = [
  {
    name: 'visa-card-statement-sara',
    folder: 'Visa',
    text: [
      'Barclaycard',
      'Barclaycard Visa',
      'SARA KHAN',
      '12 Acacia Avenue, Leeds LS6 2AB',
      'Your statement',
      'Statement date: 14 September 2026',
      'Card number ending 4421',
      'Previous balance £312.40',
      'Payments received £312.40',
      'New balance £186.22',
      'Minimum payment £25.00, due by 9 October 2026',
      'Credit limit £3,000.00',
      'Card valid until 09/29',
      'Card expiry date: 30 September 2029',
    ].join(LF),
    truth: {
      type_key: 'bank_statement',
      owner: 'm-sara',
      issued: '2026-09-14',
      expires: null,
      identifier: null,
      issued_by: 'Barclaycard',
    },
  },
  {
    name: 'visa-card-statement-ahmed',
    folder: 'Visa',
    text: [
      'Chase Freedom Visa Signature',
      'AHMED KHAN',
      'Account summary',
      'Statement closing date 09/25/2026',
      'Previous balance $1,120.05',
      'Payment, credits -$1,120.05',
      'Purchases +$842.19',
      'New balance $842.19',
      'Minimum payment due $35.00',
      'Payment due date 10/22/2026',
      'Visa',
    ].join(LF),
    truth: {
      type_key: 'bank_statement',
      owner: 'm-ahmed',
      issued: '2026-09-25',
      expires: null,
      identifier: null,
      issued_by: 'Chase',
    },
  },
  {
    name: 'pension-statement-ahmed',
    folder: 'Statements',
    text: [
      'Aviva',
      'Your annual pension statement',
      'Mr Ahmed Khan',
      'Statement date: 5 April 2026',
      'Plan number: PN 4471 2290',
      'Value of your plan on 5 April 2026: £48,210.33',
      'Contributions this year £3,600.00',
      'Your selected retirement age: 67',
    ].join(LF),
    truth: {
      type_key: 'bank_statement',
      owner: 'm-ahmed',
      issued: '2026-04-05',
      expires: null,
      identifier: 'PN 4471 2290',
      issued_by: 'Aviva',
    },
  },
  {
    name: 'tv-licence-sara',
    folder: 'Licences',
    text: [
      'TV Licensing',
      'Your TV Licence',
      'Ms Sara Khan',
      '12 Acacia Avenue, Leeds LS6 2AB',
      'Licence number: 3401 2289 7712',
      'Valid from 1 August 2026 to 31 July 2027',
      'This licence covers you to watch or record live TV on any channel.',
    ].join(LF),
    truth: {
      type_key: null,
      owner: 'm-sara',
      issued: null,
      expires: null,
      identifier: null,
      issued_by: null,
    },
  },
  {
    name: 'tv-licence-renewal-ahmed',
    folder: 'Licences',
    text: [
      'TV Licensing',
      'TV Licence renewal',
      'Mr A Khan',
      'Your licence runs out on 31 March 2027.',
      'Pay £174.50 to renew it.',
      'Licence number 8812 0043 1197',
    ].join(LF),
    truth: {
      type_key: null,
      owner: 'm-ahmed',
      issued: null,
      expires: null,
      identifier: null,
      issued_by: null,
    },
  },
];
const fixedFolder = (f: ProposalFixture) =>
  (f as Partial<(typeof CORRELATED)[number]>).folder ?? null;
const firstName = (id: string) =>
  (FIXTURE_PEOPLE.find((p) => p.id === id)?.name ?? '').split(' ').pop() as string;

/** `Ahmed/Passport/…`, `Bills/…` (a household's own), `Letters/…` for what is no kind. */
function tidy(f: ProposalFixture): string {
  const fixed = fixedFolder(f);
  if (fixed) return fixed;
  const kind = f.truth.type_key ? (FOLDER_OF[f.truth.type_key] ?? 'Other') : 'Letters';
  if (f.truth.type_key === 'utility_bill' || !f.truth.owner) return `Scans/${kind}/2024`;
  return `Scans/${firstName(f.truth.owner)}/${kind}`;
}
/** The same, with every fifth paper put in the folder of another kind. */
function messy(f: ProposalFixture, i: number): string {
  if (i % 5 !== 0 || fixedFolder(f)) return tidy(f);
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
  // Built once, and asked for each paper, as the API does.
  const match = folderMatcher({ types: KINDS, people: FIXTURE_PEOPLE });
  fixtures.forEach((f, i) => {
    const folder = folderOf ? match(folderOf(f, i)) : null;
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
  // And those the folder and the pages could both get wrong, without it and with it.
  const alone = measure(CORRELATED, null);
  const together = measure(CORRELATED, tidy);

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
        `${CORRELATED.length} the folder and the pages could both get wrong:`,
        row('no folder', alone),
        row('Visa/, Statements/, Licences/', together),
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
    // Papers the folder and the pages could both get wrong: never Ready wrongly.
    expect(alone.wrongReady).toEqual([]);
    expect(together.wrongReady).toEqual([]);
    expect(together.ready).toBe(0);
  });
});
