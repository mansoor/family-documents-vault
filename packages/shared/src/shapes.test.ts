import { describe, expect, it } from 'vitest';
import { ITEM_SURE, levelItem, type LevelKind } from './batch-levels.js';
import { periodic } from './documents.js';
import type { BatchDefaults } from './batches.js';
import { learnedIssuerKey, proposeLearned, type LearnedContext } from './learning.js';
import type { ProposalContext } from './proposals.js';
import { SHAPE_WORDS } from './shape-words.js';
import {
  familyWords,
  withoutNames,
  issuerMatches,
  lessonTrusted,
  matchShape,
  readPaper,
  shapeLessonOf,
  shapeSealed,
  shapeSimilarity,
  SHAPE_CONFIDENCE,
  SHAPE_SURE_CONFIDENCE,
  SHAPES_MAX,
  storedPaper,
  storedShape,
  storedShapeTaught,
  teachShape,
  unteachShape,
  type KeptShape,
  type PaperReading,
  type ShapeCard,
  type ShapeFiled,
} from './shapes.js';
import { FIXTURE_KINDS } from './testdata/proposal-fixtures.js';

/**
 * The vault learns each sender's papers from your corrections (0.9.0, R1):
 * what a paper's shape keeps — and never keeps — how one is matched, how
 * sure it may be, what an accept teaches it and an Undo takes back, and the
 * wrong-Ready guard.
 */

const SARA = 'm-sara';
const AHMED = 'm-ahmed';
const people = [
  { id: SARA, name: 'Sara' },
  { id: AHMED, name: 'Ahmed' },
];
const ctx: ProposalContext = {
  types: FIXTURE_KINDS,
  people,
  household: 'The Khan family',
  issuers: [{ value: 'Northgate Water', count: 3, typeKeys: ['utility_bill'] }],
  dateOrder: 'dmy',
};
const levelKinds: LevelKind[] = FIXTURE_KINDS.map((k) => ({
  key: k.key,
  label: k.label,
  default_visibility: 'household',
  expiry_driver: k.expiry_driver,
  fields: [],
}));
const none: BatchDefaults = {
  owner_member_id: null,
  type_key: null,
  visibility: null,
  physical_location: null,
  collection_id: null,
  tags: [],
  is_essential: false,
};
const day = (date: string) => ({ date, precision: 'day' as const });

/** A water bill from Northgate, as pdftotext -layout sets one out: its due date is a "Payment date". */
const bill = (o: { billed: string; pay: string; account?: string; extra?: string }) =>
  [
    'NORTHGATE WATER',
    'Your water bill',
    '',
    `Account number        ${o.account ?? 'NW 4417 3391'}          Bill date        ${o.billed}`,
    'Customer              Mr S Khan',
    '                      Bank House',
    '                      Ashby Vale',
    '                      AV4 7QT',
    '',
    'Charges for the period 1 February 2026 to 28 February 2026',
    'Standing charge                     £12.40',
    'Water supply                        £30.11',
    'Total to pay                        £42.51',
    '',
    `Payment date          ${o.pay}`,
    'We will collect this by Direct Debit from your account.',
    o.extra ?? '',
  ].join('\n');

const filedBill = (pay: string, billed: string): ShapeFiled => ({
  type_key: 'utility_bill',
  owner_member_id: SARA,
  issued: day(billed),
  expires: day(pay),
  identifier: 'NW 4417 3391',
  issued_by: 'Northgate Water',
});
const keepsAll = { issued: true, expires: true, identifier: true };
/** A keyed hash stand-in, as the API's and the thread's are (W1): 32 hex characters. */
const hash = (plain: string) =>
  Array.from(plain)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(32, '0')
    .slice(0, 32);
/** A reviewed accept, vouched for by a correction (W2), with numbers hashed (W1). */
const reviewedHashed = { reviewed: true, vouched: true, numberHash: hash };
const proposeHashed = (text: string, c: ProposalContext, l: LearnedContext) =>
  proposeLearned(text, c, l, { number: hash });
let n = 0;
const newId = () => `shape-${(n += 1)}`;

/** Each accept of a bill, taught to the shapes as the API teaches them. */
function taught(times: number, start: KeptShape[] = []) {
  let shapes = start;
  const steps = [];
  for (let i = 0; i < times; i += 1) {
    const month = String(i + 3).padStart(2, '0');
    const text = bill({ billed: `3 ${monthName(i + 3)} 2026`, pay: `20 ${monthName(i + 3)} 2026` });
    const lesson = shapeLessonOf({
      paper: readPaper(text, ctx),
      filed: filedBill(`2026-${month}-20`, `2026-${month}-03`),
      issuer: learnedIssuerKey('Northgate Water'),
      role: 'adult',
      keeps: keepsAll,
      ...reviewedHashed,
    });
    if (!lesson) throw new Error('no lesson');
    const got = teachShape(shapes, lesson, { newId, today: `2026-${month}-21` });
    shapes = got.shapes;
    steps.push(got.taught);
  }
  return { shapes, steps };
}
const monthName = (m: number) =>
  [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ][m - 1] as string;
const learnedOf = (
  shapes: KeptShape[],
  role: LearnedContext['role'] = 'adult',
): LearnedContext => ({
  rules: [],
  shapes,
  role,
  me: SARA,
});

describe('a paper’s shape (R1)', () => {
  it('keeps the heading and label words of the list, and labels each date and number by the words before it', () => {
    const p = readPaper(bill({ billed: '3 March 2026', pay: '20 March 2026' }), ctx);
    expect(p.words).toEqual(
      expect.arrayContaining(['water', 'account', 'number', 'payment', 'date', 'customer']),
    );
    expect(p.words.every((w) => SHAPE_WORDS.has(w))).toBe(true);
    expect(p.dates).toEqual(
      expect.arrayContaining([
        // "Bill" is a name as often as a word: not in the list (the R1 review, P2).
        { label: 'date', band: 1, value: day('2026-03-03') },
        { label: 'payment date', band: 4, value: day('2026-03-20') },
        // A date's own words are never a label's: "the period … to".
        { label: 'charges for the period', band: 2, value: day('2026-02-01') },
        { label: 'for the period to', band: 2, value: day('2026-02-28') },
      ]),
    );
    expect(p.numbers).toEqual([{ label: 'account number', band: 0, value: 'NW 4417 3391' }]);
  });

  it('never keeps a household’s name, its address, a number, an amount or a month', () => {
    const p = readPaper(bill({ billed: '3 May 2026', pay: '20 May 2026' }), {
      ...ctx,
      // A family whose names are everyday words: still never part of a shape.
      people: [{ id: SARA, name: 'Grace Bill' }],
      household: 'The Will family',
    });
    const kept = [
      ...p.words,
      ...p.dates.map((d) => d.label),
      ...p.numbers.map((d) => d.label),
    ].join(' ');
    for (const w of ['grace', 'bill', 'will', 'khan', 'bank', 'street', 'ashby', 'vale', 'may']) {
      expect(kept.split(' '), w).not.toContain(w);
    }
    expect(kept).not.toMatch(/\d/);
    // An address is not read at all, its column blanked: "Bank House" is not "bank".
    expect(
      readPaper(bill({ billed: '3 March 2026', pay: '20 March 2026' }), ctx).words,
    ).not.toContain('bank');
    expect(familyWords({ people: [{ id: 'x', name: 'Zoë-Anne' }], household: null })).toEqual(
      new Set(['zoe', 'anne']),
    );
  });

  it('skips the rows of a table, whose words change each time', () => {
    const rows = (merchant: string) =>
      [
        'Current account statement',
        'Statement date              30 September 2025',
        'Date        Description                 Paid out      Balance',
        `01 Sep      CARD PAYMENT ${merchant}          298.06       2209.58`,
        `06 Sep      TRANSFER ${merchant}              89.36        2120.22`,
      ].join('\n');
    const a = readPaper(rows('BOOKSHOP'), ctx).words;
    const b = readPaper(rows('CAFE'), ctx).words;
    expect(a).toEqual(b);
    expect(a).not.toContain('transfer');
  });

  it('matches by the Jaccard of its words and the issuer; a near miss is never sure', () => {
    expect(shapeSimilarity(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(0.5);
    expect(issuerMatches('northgate', 'northgate water')).toBe(true);
    expect(issuerMatches('northgate water', 'northgatewater')).toBe(false);
    const words = [
      'account',
      'bill',
      'charge',
      'customer',
      'date',
      'number',
      'payment',
      'total',
      'water',
      'your',
    ];
    const shape = { issuer: 'northgate water', words, lessons: [] };
    expect(matchShape({ words }, 'northgate water', [shape])).toMatchObject({
      similarity: 1,
      sure: true,
    });
    // Another issuer's: none.
    expect(matchShape({ words }, 'southgate water', [shape])).toBeNull();
    // Two words of ten changed: 8/12 — the same layout, unsure.
    const near = [...words.slice(0, 8), 'standing', 'supply'];
    expect(matchShape({ words: near }, 'northgate water', [shape])).toMatchObject({ sure: false });
    // The pages naming no issuer: matched only as close as a sure match, and never sure.
    expect(matchShape({ words }, '', [shape])).toMatchObject({ sure: false });
    expect(matchShape({ words: near }, '', [shape])).toBeNull();
    // Too few words to be a shape.
    expect(matchShape({ words: words.slice(0, 5) }, 'northgate water', [shape])).toBeNull();
  });
});

describe('learning a sender’s papers (R1)', () => {
  it('is sure only after three confirmations, and then reads the date where the label is', () => {
    const next = bill({ billed: '3 June 2026', pay: '20 June 2026' });
    // The pages alone: a bill, but its "Payment date" is no label they know.
    const alone = proposeHashed(next, ctx, learnedOf([]));
    expect(alone.proposal.type_key?.value).toBe('utility_bill');
    expect(alone.proposal.expires).toBeUndefined();

    const twice = proposeHashed(next, ctx, learnedOf(taught(2).shapes)).proposal;
    expect(twice.expires).toMatchObject({
      value: day('2026-06-20'),
      cue: 'learned',
      shape: true,
      confidence: SHAPE_CONFIDENCE,
    });
    expect(twice.owner_member_id).toMatchObject({ value: SARA, confidence: SHAPE_CONFIDENCE });

    const thrice = proposeHashed(next, ctx, learnedOf(taught(3).shapes)).proposal;
    expect(thrice.expires).toMatchObject({
      value: day('2026-06-20'),
      cue: 'learned',
      shape: true,
      confidence: SHAPE_SURE_CONFIDENCE,
    });
    expect(thrice.owner_member_id).toMatchObject({
      value: SARA,
      confidence: SHAPE_SURE_CONFIDENCE,
    });
    // The kind the pages read, made surer; its own confidence kept beside it.
    expect(thrice.type_key).toMatchObject({ value: 'utility_bill', shape: true, learned: true });
    expect(thrice.type_key?.page_confidence).toBe(alone.proposal.type_key?.confidence);

    // Ready only now, its suggestions marked as learned from this sender's papers.
    const level = (p: typeof thrice) =>
      levelItem({
        state: 'waiting',
        reading: 'read',
        failure: null,
        proposal: p,
        duplicate: null,
        defaults: none,
        types: levelKinds,
        people,
        role: 'adult',
        me: SARA,
      });
    expect(level(twice).level).toBe('check');
    const ready = level(thrice);
    expect(ready.level).toBe('ready');
    expect(ready.proposals?.expires).toMatchObject({ from: 'learned', shape: true });
    expect(ready.proposals?.owner_member_id).toMatchObject({ from: 'learned', shape: true });
    expect(ready.proposals?.expires?.confidence).toBeGreaterThanOrEqual(ITEM_SURE.expires);
  });

  it('a near miss is never sure: another layout of the same sender', () => {
    const shapes = taught(4).shapes;
    // The same sender's bill with a section added: the same layout, near.
    const letter = bill({
      billed: '3 June 2026',
      pay: '20 June 2026',
      extra: [
        'Important information about your tariff',
        'Contact us online or by telephone',
        'Your meter reading',
      ].join('\n'),
    });
    const m = matchShape(readPaper(letter, ctx), 'northgate water', shapes);
    expect(m?.similarity).toBeGreaterThanOrEqual(0.5);
    expect(m?.similarity).toBeLessThan(0.8);
    expect(m?.sure).toBe(false);
    const got = proposeHashed(letter, ctx, learnedOf(shapes)).proposal;
    for (const f of ['type_key', 'owner_member_id', 'expires'] as const) {
      const p = got[f];
      if (!p?.shape) continue;
      // What the shape alone proposed is unsure; what the pages read, it makes no surer.
      if (p.cue === 'learned') expect(p.confidence, f).toBeLessThan(SHAPE_SURE_CONFIDENCE);
      else expect(p.confidence, f).toBe(p.page_confidence);
    }
    expect(got.expires).toMatchObject({ cue: 'learned', confidence: SHAPE_CONFIDENCE });
  });

  it('a contradiction unlearns: a lesson contradicted is never sure again', () => {
    const { shapes } = taught(4);
    const text = bill({ billed: '3 July 2026', pay: '20 July 2026' });
    // Filed for Ahmed, and with the bill date as its due date.
    const lesson = shapeLessonOf({
      paper: readPaper(text, ctx),
      filed: { ...filedBill('2026-07-03', '2026-07-03'), owner_member_id: AHMED },
      issuer: 'northgate water',
      role: 'adult',
      keeps: keepsAll,
      ...reviewedHashed,
    });
    const after = teachShape(shapes, lesson as NonNullable<typeof lesson>, {
      newId,
      today: '2026-07-21',
    }).shapes;
    const s = after[0] as KeptShape;
    const of = (field: string, value: string) =>
      s.lessons.find((l) => l.field === field && l.value === value);
    expect(of('owner_member_id', SARA)).toMatchObject({ confirmed: 4, contradicted: 1 });
    expect(lessonTrusted(of('owner_member_id', SARA) as never, s)).toBe(false);
    expect(of('expires', 'payment date')).toMatchObject({ confirmed: 4, contradicted: 1 });
    const next = proposeHashed(
      bill({ billed: '3 August 2026', pay: '20 August 2026' }),
      ctx,
      learnedOf(after),
    ).proposal;
    expect(next.owner_member_id?.confidence ?? 0).toBeLessThan(SHAPE_SURE_CONFIDENCE);
    expect(next.expires?.confidence ?? 0).toBeLessThan(SHAPE_SURE_CONFIDENCE);
  });

  it('an Undo takes back exactly what its accept taught', () => {
    const before = taught(3).shapes;
    const text = bill({ billed: '3 June 2026', pay: '20 June 2026' });
    const lesson = shapeLessonOf({
      paper: readPaper(text, ctx),
      filed: { ...filedBill('2026-06-03', '2026-06-03'), owner_member_id: AHMED },
      issuer: 'northgate water',
      role: 'adult',
      keeps: keepsAll,
      ...reviewedHashed,
    }) as NonNullable<ReturnType<typeof shapeLessonOf>>;
    const got = teachShape(before, lesson, { newId, today: '2026-06-21' });
    expect(got.shapes).not.toEqual(before);
    const undone = unteachShape(got.shapes, got.taught);
    expect(undone.map((s) => ({ ...s, last_used: 'x' }))).toEqual(
      before.map((s) => ({ ...s, last_used: 'x' })),
    );
    // And the first accept's Undo leaves nothing: the shape it made goes.
    const first = taught(1);
    expect(unteachShape(first.shapes, first.steps[0] as never)).toEqual([]);
    // What an outcome keeps of it opens as it was.
    expect(storedShapeTaught(JSON.parse(JSON.stringify({ v: 1, ...got.taught })))).toEqual(
      got.taught,
    );
  });

  it('keeps at most SHAPES_MAX a person, the least used going first', () => {
    const many: KeptShape[] = Array.from({ length: SHAPES_MAX }, (_, i) => ({
      id: `old-${String(i).padStart(3, '0')}`,
      issuer: `sender ${i}`,
      words: ['account', 'bill', 'date', 'number', 'payment', 'total', 'water', 'your'],
      lessons: [
        { field: 'type_key', value: 'utility_bill', band: null, confirmed: 1, contradicted: 0 },
      ],
      last_used: i === 0 ? '2020-01-01' : '2026-01-01',
    }));
    const got = teachShape(
      many,
      shapeLessonOf({
        paper: readPaper(bill({ billed: '3 March 2026', pay: '20 March 2026' }), ctx),
        filed: filedBill('2026-03-20', '2026-03-03'),
        issuer: 'northgate water',
        role: 'adult',
        keeps: keepsAll,
        ...reviewedHashed,
        ...reviewedHashed,
      }) as NonNullable<ReturnType<typeof shapeLessonOf>>,
      { newId, today: '2026-03-21' },
    );
    expect(got.shapes).toHaveLength(SHAPES_MAX);
    expect(got.shapes.some((s) => s.id === 'old-000')).toBe(false);
    expect(got.taught.evicted.map((s) => s.id)).toEqual(['old-000']);
    expect(
      unteachShape(got.shapes, got.taught)
        .map((s) => s.id)
        .sort(),
    ).toEqual(many.map((s) => s.id).sort());
  });

  it('teaches a teen no person: their documents are their own', () => {
    const lesson = shapeLessonOf({
      paper: readPaper(bill({ billed: '3 March 2026', pay: '20 March 2026' }), ctx),
      filed: filedBill('2026-03-20', '2026-03-03'),
      issuer: 'northgate water',
      role: 'teen',
      keeps: keepsAll,
      ...reviewedHashed,
    });
    expect(lesson?.steps.map((s) => s.field)).not.toContain('owner_member_id');
    // And a teen's shape that says a person (planted) proposes none for them.
    const { shapes } = taught(3);
    const got = proposeHashed(
      bill({ billed: '3 June 2026', pay: '20 June 2026' }),
      ctx,
      learnedOf(shapes, 'teen'),
    );
    expect(got.proposal.owner_member_id?.shape).toBeUndefined();
  });
});

describe('the wrong-Ready guard (R1)', () => {
  const level = (text: string, shapes: KeptShape[]) => {
    const got = proposeHashed(text, ctx, learnedOf(shapes));
    return {
      got,
      level: levelItem({
        state: 'waiting',
        reading: 'read',
        failure: null,
        proposal: got.proposal,
        learnedClash: got.clash,
        duplicate: null,
        defaults: none,
        types: levelKinds,
        people,
        role: 'adult',
        me: SARA,
      }),
    };
  };

  it('a sure shape disagreeing with a strong page reading gives Check: the pages’ stands', () => {
    const { shapes } = taught(3);
    // This bill also says "Due date", which the pages read strongly — and
    // the shape's "Payment date" says another day.
    const text = bill({
      billed: '3 June 2026',
      pay: '20 June 2026',
      extra: 'Due date              25 June 2026',
    });
    const { got, level: l } = level(text, shapes);
    expect(got.proposal.expires).toMatchObject({ value: day('2026-06-25') });
    expect(got.proposal.expires?.cue).not.toBe('learned');
    expect(got.clash.expires).toBe('2026-06-20');
    expect(l.level).toBe('check');
    expect(l.tags.map((t) => t.code)).toContain('clash_learned');
    expect(l.tags.find((t) => t.code === 'clash_learned')?.words).toBe(
      'The pages and your earlier papers from Northgate Water give different expiry dates',
    );
  });

  it('a sure shape for another kind than the pages read strongly gives Check', () => {
    const { shapes } = taught(3);
    const kinded = shapes.map((s) => ({
      ...s,
      lessons: s.lessons.map((l) => (l.field === 'type_key' ? { ...l, value: 'loan' } : l)),
    }));
    const { got, level: l } = level(bill({ billed: '3 June 2026', pay: '20 June 2026' }), kinded);
    expect(got.proposal.type_key?.value).toBe('utility_bill');
    expect(got.clash.type_key).toBe('loan');
    expect(l.level).not.toBe('ready');
    // And none of its dates: they are the loan's.
    expect(got.proposal.expires?.shape).toBeUndefined();
  });
});

describe('what a shape is stored as (R1)', () => {
  it('opens only words of the list and labels of them: anything planted is dropped', () => {
    const planted = {
      v: 1,
      issuer: 'northgate water',
      words: ['account', 'zanzibarquokka', 'X9F2K7Q41', 'water'],
      lessons: [
        { field: 'expires', value: 'payment date', band: 4, confirmed: 3, contradicted: 0 },
        { field: 'expires', value: 'zanzibar quokka', band: 4, confirmed: 3, contradicted: 0 },
        { field: 'identifier', value: 'X9F2K7Q41', band: 1, confirmed: 3, contradicted: 0 },
        { field: 'type_key', value: 'utility_bill', band: null, confirmed: 3, contradicted: 0 },
        { field: 'nonsense', value: 'x', band: null, confirmed: 1, contradicted: 0 },
        // A person's numbers: hashes alone, as 32 hex characters (W1).
        {
          field: 'owner_member_id',
          value: SARA,
          band: null,
          confirmed: 3,
          contradicted: 0,
          vouched: 1,
          numbers: ['X9F2K7Q41', 'a'.repeat(32)],
        },
      ],
    };
    expect(storedShape(planted)).toEqual({
      issuer: 'northgate water',
      words: ['account', 'water'],
      lessons: [
        { field: 'expires', value: 'payment date', band: 4, confirmed: 3, contradicted: 0 },
        { field: 'type_key', value: 'utility_bill', band: null, confirmed: 3, contradicted: 0 },
        {
          field: 'owner_member_id',
          value: SARA,
          band: null,
          confirmed: 3,
          contradicted: 0,
          vouched: 1,
          numbers: ['a'.repeat(32)],
        },
      ],
    });
    expect(storedShape({ ...planted, v: 2 })).toBeNull();
    const paper: PaperReading = {
      words: ['account', 'olivia'],
      dates: [
        { label: 'payment date', band: 4, value: day('2026-03-20') },
        { label: 'olivia khan', band: 4, value: day('2026-03-20') },
      ],
      numbers: [{ label: 'account number', band: 0, value: 'NW 4417' }],
    };
    expect(storedPaper({ v: 1, paper })).toEqual({
      words: ['account'],
      dates: [{ label: 'payment date', band: 4, value: day('2026-03-20') }],
      numbers: [{ label: 'account number', band: 0, value: 'NW 4417' }],
    });
    expect(shapeSealed(storedShape(planted) as never)).toMatchObject({ v: 1 });
  });
});

describe('the R1 review', () => {
  const level = (p: ReturnType<typeof proposeLearned>) =>
    levelItem({
      state: 'waiting',
      reading: 'read',
      failure: null,
      proposal: p.proposal,
      learnedClash: p.clash,
      duplicate: null,
      defaults: none,
      types: levelKinds,
      people,
      role: 'adult',
      me: SARA,
    });
  /** The statement the reviewer used: addressed to "MR KHAN", naming nobody the pages can place. */
  const toMrKhan = (account: string) =>
    bill({ billed: '3 June 2026', pay: '20 June 2026', account }).replace(
      'Customer              Mr S Khan',
      'Customer              MR KHAN',
    );

  it('W1: two of the family with the same bank: a learned person is sure only on their own account', () => {
    const { shapes } = taught(3);
    // Ahmed's statement from the same bank, another account: Sara is offered, unsure, and it is Check.
    const ahmeds = proposeHashed(toMrKhan('NW 9999 0001'), ctx, learnedOf(shapes));
    expect(ahmeds.proposal.owner_member_id).toMatchObject({
      value: SARA,
      confidence: SHAPE_CONFIDENCE,
    });
    expect(level(ahmeds).level).toBe('check');
    // Sara's own, the account her lesson was taught with: sure, and Ready.
    const saras = proposeHashed(toMrKhan('NW 4417 3391'), ctx, learnedOf(shapes));
    expect(saras.proposal.owner_member_id).toMatchObject({
      value: SARA,
      confidence: SHAPE_SURE_CONFIDENCE,
    });
    expect(level(saras).level).toBe('ready');
    // Without the hash (a thread with no key), never sure.
    expect(
      proposeLearned(toMrKhan('NW 4417 3391'), ctx, learnedOf(shapes)).proposal.owner_member_id,
    ).toMatchObject({ confidence: SHAPE_CONFIDENCE });
    // The lesson keeps the number's hash, never the number: once for each paper.
    const lesson = shapes[0]?.lessons.find((l) => l.field === 'owner_member_id');
    expect(lesson?.numbers).toEqual([hash('NW44173391'), hash('NW44173391'), hash('NW44173391')]);
    expect(JSON.stringify(shapes)).not.toContain('4417');
  });

  it('W2: Accept all Ready teaches nothing; confirmations none vouched for are never sure; a default alone teaches no person', () => {
    const text = bill({ billed: '3 March 2026', pay: '20 March 2026' });
    const base = {
      paper: readPaper(text, ctx),
      filed: filedBill('2026-03-20', '2026-03-03'),
      issuer: 'northgate water',
      role: 'adult' as const,
      keeps: keepsAll,
      numberHash: hash,
    };
    expect(shapeLessonOf({ ...base, reviewed: false, vouched: true })).toBeNull();
    let shapes: KeptShape[] = [];
    for (let i = 0; i < 4; i += 1) {
      const lesson = shapeLessonOf({ ...base, reviewed: true, vouched: false });
      shapes = teachShape(shapes, lesson as never, { newId, today: '2026-03-21' }).shapes;
    }
    const lessons = shapes[0]?.lessons ?? [];
    expect(lessons.every((l) => l.confirmed === 4 && !l.vouched)).toBe(true);
    expect(lessons.some((l) => lessonTrusted(l, shapes[0] as KeptShape))).toBe(false);
    // One vouched for, and they are.
    const once = teachShape(
      shapes,
      shapeLessonOf({ ...base, reviewed: true, vouched: true }) as never,
      { newId, today: '2026-03-22' },
    ).shapes;
    expect(once[0]?.lessons.every((l) => lessonTrusted(l, once[0] as KeptShape))).toBe(true);
    // The batch said whose it is, and it was filed so: no person learned.
    const fromBatch = shapeLessonOf({
      ...base,
      reviewed: true,
      vouched: true,
      card: { owner_member_id: { value: SARA, from: 'batch' } },
    });
    expect(fromBatch?.steps.map((s) => s.field)).not.toContain('owner_member_id');
  });

  it('W3: a runner-up within 0.1 that says another person makes the match unsure', () => {
    const words = [
      'account',
      'charge',
      'customer',
      'date',
      'number',
      'payment',
      'total',
      'water',
      'your',
      'supply',
    ];
    const lessonFor = (who: string) => ({
      field: 'owner_member_id' as const,
      value: who,
      band: null,
      confirmed: 5,
      contradicted: 0,
      vouched: 1,
    });
    const a = { issuer: 'northgate water', words, lessons: [lessonFor(SARA)] };
    const b = {
      issuer: 'northgate water',
      words: [...words, 'standing'],
      lessons: [lessonFor(AHMED)],
    };
    expect(matchShape({ words }, 'northgate water', [a])?.sure).toBe(true);
    expect(matchShape({ words }, 'northgate water', [a, b])).toMatchObject({
      shape: a,
      sure: false,
    });
    // The same person on both: nothing to choose between.
    const same = { ...b, lessons: [lessonFor(SARA)] };
    expect(matchShape({ words }, 'northgate water', [a, same])?.sure).toBe(true);
  });

  it('W4: a sure match needs the pages to name the issuer exactly; one that begins with it is unsure', () => {
    const words = ['account', 'charge', 'customer', 'date', 'number', 'payment', 'total', 'water'];
    const shape = { issuer: 'northgate water', words, lessons: [] };
    expect(matchShape({ words }, 'northgate water', [shape])?.sure).toBe(true);
    expect(matchShape({ words }, 'northgate', [shape])).toMatchObject({ sure: false });
  });

  it('P1: a line with no value that parts into columns gives only its label column', () => {
    const p = readPaper(
      [
        'Northgate Water customer account',
        'Payment method          Direct debit',
        'Account status          Active',
      ].join('\n'),
      ctx,
    );
    expect(p.words).toEqual(expect.arrayContaining(['payment', 'method', 'account', 'status']));
    for (const value of ['direct', 'debit', 'active']) expect(p.words).not.toContain(value);
    for (const w of ['male', 'female', 'single', 'yes', 'no', 'diagnosis', 'disability', 'allergy'])
      expect(SHAPE_WORDS.has(w), w).toBe(false);
  });

  it('P2: an addressee block with no UK postcode is no part of a shape; nor is a guest’s name', () => {
    const letter = [
      'Northgate Water customer letter',
      '',
      'Ms Jane Doe',
      'Customer Centre',
      'Account Office',
      'Springfield, IL 62704',
      '',
      'Dear Payment Team,',
      'Your account number     NW 4417 3391',
    ].join('\n');
    const p = readPaper(letter, ctx);
    for (const w of ['centre', 'office', 'team']) expect(p.words, w).not.toContain(w);
    expect(p.numbers.map((x) => x.label)).toEqual(['your account number']);
    // A guest called "Rose Account": their name is no word of a shape.
    const withGuest = readPaper(letter, { ...ctx, guests: [{ id: 'g', name: 'Rose Account' }] });
    expect(withGuest.words).not.toContain('account');
    // And a stored shape loses a word that is now somebody's name.
    const shape = {
      issuer: 'northgate water',
      words: ['account', 'number', 'water'],
      lessons: [
        {
          field: 'identifier' as const,
          value: 'account number',
          band: 0,
          confirmed: 3,
          contradicted: 0,
        },
        {
          field: 'expires' as const,
          value: 'payment date',
          band: 4,
          confirmed: 3,
          contradicted: 0,
        },
      ],
    };
    expect(withoutNames(shape, new Set(['account']))).toEqual({
      issuer: 'northgate water',
      words: ['number', 'water'],
      lessons: [shape.lessons[1]],
    });
    expect(withoutNames(shape, new Set(['nobody']))).toBe(shape);
  });

  it('PERF1: long runs of a number’s characters are read in linear time, and a shape that fails costs the page its shape, not its proposal', () => {
    const run = (n: number) => `${'7 '.repeat(n / 2 - 1)}x!`;
    const text = [
      ...Array.from({ length: 10 }, () => `Ref ${run(800)}`),
      ...Array.from({ length: 3 }, () => `Ref ${run(1500)}`),
    ].join('\n');
    const started = Date.now();
    readPaper(text, ctx);
    expect(Date.now() - started).toBeLessThan(500);
    // A context the shape cannot be read with: the pages' proposal all the same.
    const broken = { ...ctx, guests: {} as unknown as ProposalContext['guests'] };
    const page = bill({ billed: '3 March 2026', pay: '20 March 2026' });
    expect(() => readPaper(page, broken)).toThrow();
    const got = proposeHashed(page, broken, learnedOf(taught(3).shapes));
    expect(got.paper).toBeUndefined();
    expect(got.proposal.type_key).toMatchObject({ value: 'utility_bill' });
  });

  it('periodic kinds: not a prescription; pay and investment statements once they are kinds', () => {
    expect(periodic({ key: 'prescription' })).toBe(false);
    for (const key of ['pay_statement', 'investment_statement', 'bank_statement', 'utility_bill'])
      expect(periodic({ key }), key).toBe(true);
    expect(periodic({ key: 'h_payslips' })).toBe(false);
  });
});

describe('a sender of several layouts (the R1 review, the careless simulation)', () => {
  /** Northgate's leaflet: another layout, from the same sender, naming no kind. */
  const leaflet = [
    'NORTHGATE WATER',
    'Customer notice',
    '',
    'Planned work in your area',
    'Reference             Supply interruption',
    'Start date            4 May 2026',
    'Contact centre        Monday to Friday',
    'Customer services     Opening hours',
    'Your supply may be off for a short period.',
  ].join('\n');
  const rules = [
    {
      issuer_key: 'northgate water',
      field: 'type_key' as const,
      value: 'utility_bill',
      confirmed: 5,
      contradicted: 0,
    },
  ];
  // The bills' layout, taught 3 times; the leaflet's, filed once as a bill (carelessly).
  const bills = taught(3).shapes;
  const leafletShape: KeptShape = {
    ...(bills[0] as KeptShape),
    id: 'shape-leaflet',
    words: readPaper(leaflet, ctx).words,
    lessons: [
      {
        field: 'type_key',
        value: 'utility_bill',
        band: null,
        confirmed: 1,
        contradicted: 0,
        vouched: 1,
      },
    ],
  };
  const kindOf = (text: string, shapes: KeptShape[]) =>
    proposeHashed(text, ctx, { ...learnedOf(shapes), rules }).proposal.type_key;

  it('a trusted issuer rule is sure only on a page of a layout whose own lesson is trusted', () => {
    expect(readPaper(leaflet, ctx).words.length).toBeGreaterThanOrEqual(8);
    // A layout not learned yet: the rule speaks for the sender, as in I4.
    expect(kindOf(leaflet, bills)).toMatchObject({ value: 'utility_bill', confidence: 0.9 });
    // The leaflet's layout was filed as a bill once, so the rule is unsure on it,
    // whether the bills taught a layout of their own...
    expect(kindOf(leaflet, [...bills, leafletShape])).toMatchObject({
      value: 'utility_bill',
      confidence: 0.78,
    });
    // ...or none (the simulation's surgery: its letters taught no shape).
    expect(kindOf(leaflet, [leafletShape])?.confidence).toBeLessThan(SHAPE_SURE_CONFIDENCE);
    // ...and sure on a bill, whose layout's lesson is trusted.
    const onBill = kindOf(bill({ billed: '3 July 2026', pay: '20 July 2026' }), [
      ...bills,
      leafletShape,
    ]);
    expect(onBill?.value).toBe('utility_bill');
    expect(onBill?.confidence).toBeGreaterThanOrEqual(SHAPE_SURE_CONFIDENCE);
  });
});

describe('whose account it is (the R1 review’s follow-up)', () => {
  const SARAS = 'NW 4417 3391';
  const AHMEDS = 'NW 5520 1180';
  /** A statement addressed to "MR KHAN": the pages cannot place it, only its account. */
  const statement = (account: string, month: number) =>
    bill({
      billed: `3 ${monthName(month)} 2026`,
      pay: `20 ${monthName(month)} 2026`,
      account,
    }).replace('Customer              Mr S Khan', 'Customer              MR KHAN');
  /** Sara files `who`'s statement on `account`, as the API teaches it: her shapes, her key. */
  const file = (
    shapes: KeptShape[],
    who: string,
    account: string,
    month: number,
    vouched = true,
  ) => {
    const mm = String(month).padStart(2, '0');
    const lesson = shapeLessonOf({
      paper: readPaper(statement(account, month), ctx),
      filed: {
        ...filedBill(`2026-${mm}-20`, `2026-${mm}-03`),
        owner_member_id: who,
        identifier: account,
      },
      issuer: learnedIssuerKey('Northgate Water'),
      role: 'adult',
      keeps: keepsAll,
      ...reviewedHashed,
      vouched,
    });
    if (!lesson) throw new Error('no lesson');
    return teachShape(shapes, lesson, { newId, today: `2026-${mm}-21` });
  };
  const fileAll = (steps: Array<[string, string]>, vouched = true) => {
    let shapes: KeptShape[] = [];
    for (const [i, [who, account]] of steps.entries()) {
      shapes = file(shapes, who, account, (i % 12) + 1, vouched).shapes;
    }
    return shapes;
  };
  const personOn = (account: string, shapes: KeptShape[], role: LearnedContext['role'] = 'adult') =>
    proposeHashed(statement(account, 11), ctx, learnedOf(shapes, role)).proposal.owner_member_id;
  const both = fileAll([
    [SARA, SARAS],
    [AHMED, AHMEDS],
    [SARA, SARAS],
    [AHMED, AHMEDS],
    [SARA, SARAS],
    [AHMED, AHMEDS],
  ]);

  it('proposes, sure, the person whose account the page is — Sara filing Ahmed’s statements as well as her own', () => {
    expect(both).toHaveLength(1);
    expect(personOn(AHMEDS, both)).toMatchObject({
      value: AHMED,
      confidence: SHAPE_SURE_CONFIDENCE,
      shape: true,
    });
    expect(personOn(SARAS, both)).toMatchObject({ value: SARA, confidence: SHAPE_SURE_CONFIDENCE });
    // Another account at the same bank says nothing against them.
    const people = both[0]?.lessons.filter((l) => l.field === 'owner_member_id') ?? [];
    expect(people.map((l) => [l.value, l.confirmed, l.contradicted])).toEqual([
      [SARA, 3, 0],
      [AHMED, 3, 0],
    ]);
  });

  it('an account nobody’s, or anybody’s but one person’s, is as before: unsure', () => {
    // (Here nobody at all: the two of them filed as often, so the layout cannot choose.)
    expect(personOn('NW 7777 0003', both)?.confidence ?? 0).toBeLessThan(SHAPE_SURE_CONFIDENCE);
    // Ahmed's account filed for Sara as well (a joint account, three times): it says neither.
    let shared = both;
    for (const month of [7, 8, 9]) shared = file(shared, SARA, AHMEDS, month).shapes;
    expect(personOn(AHMEDS, shared)?.confidence ?? 0).toBeLessThan(SHAPE_SURE_CONFIDENCE);
    // Ahmed's account filed only twice: not yet.
    const twice = fileAll([
      [SARA, SARAS],
      [AHMED, AHMEDS],
      [SARA, SARAS],
      [AHMED, AHMEDS],
      [SARA, SARAS],
    ]);
    expect(personOn(AHMEDS, twice)).toMatchObject({ value: AHMED, confidence: SHAPE_CONFIDENCE });
    // An Undo takes back its paper's time: twice again.
    const third = file(twice, AHMED, AHMEDS, 8);
    expect(personOn(AHMEDS, third.shapes)?.confidence).toBe(SHAPE_SURE_CONFIDENCE);
    const undone = unteachShape(third.shapes, third.taught);
    expect(personOn(AHMEDS, undone)?.confidence ?? 0).toBeLessThan(SHAPE_SURE_CONFIDENCE);
    // Exactly its own: one more paper, and it is three again.
    expect(personOn(AHMEDS, file(undone, AHMED, AHMEDS, 9).shapes)?.confidence).toBe(
      SHAPE_SURE_CONFIDENCE,
    );
  });

  it('none vouched for, or another lesson too full of accounts to tell, and the account is not sure', () => {
    const unvouched = fileAll(
      [
        [SARA, SARAS],
        [AHMED, AHMEDS],
        [SARA, SARAS],
        [AHMED, AHMEDS],
        [SARA, SARAS],
        [AHMED, AHMEDS],
      ],
      false,
    );
    expect(personOn(AHMEDS, unvouched)?.confidence ?? 0).toBeLessThan(SHAPE_SURE_CONFIDENCE);
    // Sara's lesson holds SHAPE_PERSON_NUMBERS accounts: whether Ahmed's was once hers, it cannot say.
    let full = both;
    for (let i = 0; i < 8; i += 1)
      full = file(full, SARA, `NW 1000 00${10 + i}`, (i % 12) + 1).shapes;
    expect(personOn(AHMEDS, full)?.confidence ?? 0).toBeLessThan(SHAPE_SURE_CONFIDENCE);
  });

  it('a teen’s shapes learn and propose no person, and a thread with no key is never sure', () => {
    expect(personOn(AHMEDS, both, 'teen')).toBeUndefined();
    expect(
      proposeLearned(statement(AHMEDS, 11), ctx, learnedOf(both)).proposal.owner_member_id
        ?.confidence ?? 0,
    ).toBeLessThan(SHAPE_SURE_CONFIDENCE);
  });
});

describe('the R1 re-check', () => {
  const SARAS = 'NW 4417 3391';
  const AHMEDS = 'NW 5520 1180';
  /** A statement addressed to "MR KHAN": the pages cannot place it, only its account. */
  const statement = (account: string, month: number) =>
    bill({
      billed: `3 ${monthName(month)} 2026`,
      pay: `20 ${monthName(month)} 2026`,
      account,
    }).replace('Customer              Mr S Khan', 'Customer              MR KHAN');
  type Proposal = ReturnType<typeof proposeHashed>;
  const levelOf = (p: Proposal) =>
    levelItem({
      state: 'waiting',
      reading: 'read',
      failure: null,
      proposal: p.proposal,
      learnedClash: p.clash,
      duplicate: null,
      defaults: none,
      types: levelKinds,
      people,
      role: 'adult',
      me: SARA,
    }).level;
  /** The card as levelItem shows it: each field, and where it came from. */
  const cardOf = (p: Proposal) =>
    Object.fromEntries(
      Object.entries(p.proposal).map(([field, s]) => {
        const x = s as { value: unknown; cue?: string; learned?: boolean; shape?: boolean };
        return [
          field,
          {
            value: x.value,
            from: x.cue === 'learned' || x.learned ? 'learned' : 'pages',
            cue: x.cue ?? null,
            ...(x.shape ? { shape: true } : {}),
          },
        ];
      }),
    );
  const teach = (
    shapes: KeptShape[],
    o: { month: number; account: string; who: string; card?: ShapeCard | null },
  ) => {
    const mm = String(o.month).padStart(2, '0');
    const lesson = shapeLessonOf({
      paper: readPaper(statement(o.account, o.month), ctx),
      filed: {
        ...filedBill(`2026-${mm}-20`, `2026-${mm}-03`),
        owner_member_id: o.who,
        identifier: o.account,
      },
      issuer: learnedIssuerKey('Northgate Water'),
      role: 'adult',
      keeps: keepsAll,
      reviewed: true,
      vouched: true,
      numberHash: hash,
      card: o.card ?? null,
    });
    return lesson ? teachShape(shapes, lesson, { newId, today: `2026-${mm}-21` }) : null;
  };

  it('N1: an issuer rule sure of Sara, and a lesson that trusts her, are unsure on Ahmed’s other account', () => {
    const shapes = taught(3).shapes;
    const rules = [
      {
        issuer_key: 'northgate water',
        field: 'owner_member_id' as const,
        value: SARA,
        confirmed: 5,
        contradicted: 0,
      },
    ];
    const learned = { ...learnedOf(shapes), rules };
    // Sara's own account: sure, and Ready.
    const saras = proposeHashed(statement(SARAS, 7), ctx, learned);
    expect(saras.proposal.owner_member_id?.confidence).toBeGreaterThanOrEqual(0.9);
    // Ahmed's, which no paper of Sara's was filed with: unsure, and Check.
    const ahmeds = proposeHashed(statement(AHMEDS, 7), ctx, learned);
    expect(ahmeds.proposal.owner_member_id).toMatchObject({
      value: SARA,
      confidence: SHAPE_CONFIDENCE,
    });
    expect(levelOf(ahmeds)).toBe('check');
  });

  it('N2: a paper misfiled, then its shape’s suggestion accepted as shown again and again, never becomes Ready', () => {
    // Sara's bill filed as Ahmed's: a change, so vouched for.
    let shapes = teach([], { month: 1, account: SARAS, who: AHMED })?.shapes ?? [];
    const levels: string[] = [];
    for (let month = 2; month <= 8; month += 1) {
      const p = proposeHashed(statement(SARAS, month), ctx, learnedOf(shapes));
      levels.push(levelOf(p) ?? 'none');
      // Accepted exactly as shown: Ahmed, the shape's own suggestion.
      const shown = p.proposal.owner_member_id?.value ?? AHMED;
      shapes =
        teach(shapes, { month, account: SARAS, who: shown, card: cardOf(p) })?.shapes ?? shapes;
    }
    expect(levels).not.toContain('ready');
    // Its own echo taught it nothing: still the one paper.
    const lesson = shapes[0]?.lessons.find((l) => l.field === 'owner_member_id');
    expect(lesson).toMatchObject({ value: AHMED, confirmed: 1 });
    // A value the pages proposed, confirmed on a card looked at, still teaches.
    const kind = shapes[0]?.lessons.find((l) => l.field === 'type_key');
    expect(kind?.confirmed).toBeGreaterThanOrEqual(3);
  });

  it('N3: a lesson only ever misfiled is unlearned in time by the other accounts filed after it', () => {
    // Ahmed's account, misfiled three times as Sara's...
    let shapes: KeptShape[] = [];
    for (const month of [1, 2, 3]) {
      shapes = teach(shapes, { month, account: 'NW 9000 0001', who: SARA })?.shapes ?? shapes;
    }
    // ...then Ahmed's other statements, on his own account, filed rightly.
    for (let i = 0; i < 12; i += 1) {
      shapes =
        teach(shapes, { month: (i % 12) + 1, account: AHMEDS, who: AHMED })?.shapes ?? shapes;
    }
    const sara = shapes[0]?.lessons.find((l) => l.field === 'owner_member_id' && l.value === SARA);
    expect(sara).toBeUndefined();
    // Eleven are not yet enough: three of them weigh as one contradiction.
    let fewer: KeptShape[] = [];
    for (const month of [1, 2, 3]) {
      fewer = teach(fewer, { month, account: 'NW 9000 0001', who: SARA })?.shapes ?? fewer;
    }
    for (let i = 0; i < 11; i += 1) {
      fewer = teach(fewer, { month: (i % 12) + 1, account: AHMEDS, who: AHMED })?.shapes ?? fewer;
    }
    expect(
      fewer[0]?.lessons.find((l) => l.field === 'owner_member_id' && l.value === SARA),
    ).toMatchObject({ confirmed: 3, contradicted: 0, drift: 11 });
  });

  it('N4: the account rule is never sure of a lesson ever contradicted', () => {
    let shapes: KeptShape[] = [];
    for (const [month, who, account] of [
      [1, SARA, SARAS],
      [2, AHMED, AHMEDS],
      [3, SARA, SARAS],
      [4, AHMED, AHMEDS],
      [5, SARA, SARAS],
      [6, AHMED, AHMEDS],
    ] as const) {
      shapes = teach(shapes, { month, account, who })?.shapes ?? shapes;
    }
    const sure = proposeHashed(statement(AHMEDS, 9), ctx, learnedOf(shapes));
    expect(sure.proposal.owner_member_id).toMatchObject({
      value: AHMED,
      confidence: SHAPE_SURE_CONFIDENCE,
    });
    // One of the bank's statements filed for Sara with no number at all: it
    // says nothing of whose any account is, so it contradicts Ahmed's lesson.
    shapes = teach(shapes, { month: 7, account: '', who: SARA })?.shapes ?? shapes;
    const after = proposeHashed(statement(AHMEDS, 9), ctx, learnedOf(shapes));
    expect(after.proposal.owner_member_id?.confidence ?? 0).toBeLessThan(SHAPE_SURE_CONFIDENCE);
  });

  it('a number on a line set out with single spaces does not carry its label’s words', () => {
    const p = readPaper(
      [
        'NORTHGATE WATER',
        'Your water bill',
        'Account number NW 4417 3391',
        'Customer reference AB 1234 567',
      ].join('\n'),
      ctx,
    );
    expect(p.numbers.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: 'account number', value: 'NW 4417 3391' },
      { label: 'customer reference', value: 'AB 1234 567' },
    ]);
  });
});
